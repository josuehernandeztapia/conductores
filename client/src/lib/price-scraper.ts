/**
 * Client-Side Price Scraper
 * 
 * Runs in the USER'S BROWSER (residential IP) to bypass datacenter blocks.
 * Scrapes Kavak HTML + MercadoLibre API, then sends results to server cache.
 * 
 * Flow: Browser scrapes → POST /api/market-cache → DB → market-prices reads cache
 */

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Models to scrape: all CMU catalog models + common taxi models
const SCRAPE_TARGETS = [
  // CMU catalog
  { brand: "Chevrolet", model: "Aveo", years: [2021, 2022, 2023, 2024] },
  { brand: "Nissan", model: "March", years: [2021, 2022, 2023, 2024] },
  { brand: "Nissan", model: "V-Drive", years: [2021, 2022, 2023] },
  { brand: "Volkswagen", model: "Vento", years: [2021, 2022, 2023] },
  { brand: "Toyota", model: "Yaris", years: [2021, 2022, 2023] },
  { brand: "Hyundai", model: "Grand i10", years: [2022, 2023, 2024] },
  { brand: "Kia", model: "Rio", years: [2022, 2023, 2024] },
  // Additional common models
  { brand: "Nissan", model: "Versa", years: [2021, 2022, 2023, 2024] },
  { brand: "Chevrolet", model: "Spark", years: [2021, 2022, 2023] },
  { brand: "Renault", model: "Kwid", years: [2022, 2023, 2024, 2025] },
];

type ScrapeResult = {
  brand: string;
  model: string;
  year: number;
  prices: number[];
  sources: string;
  error?: string;
};

type ScrapeProgress = {
  current: number;
  total: number;
  currentModel: string;
  results: ScrapeResult[];
  errors: string[];
};

// === KAVAK SCRAPER ===
async function scrapeKavak(brand: string, model: string, year: number): Promise<number[]> {
  const brandSlug = brand.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const modelSlug = model.toLowerCase().replace(/[- ]/g, "-").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const url = `https://www.kavak.com/mx/seminuevos/${brandSlug}/${modelSlug}/${year}`;
  
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const html = await res.text();
    
    const prices: number[] = [];
    
    // Strategy A: "Precio desde" blocks
    const precioDesde = html.match(/Precio\s*(?:desde|contado\s*desde)[\s\S]{0,200}?\$\s*([\d]{1,3}(?:[,.]?\d{3})+)/gi) || [];
    for (const block of precioDesde) {
      const pm = block.match(/\$\s*([\d]{1,3}(?:[,.]?\d{3})+)/);
      if (pm) {
        const p = parseInt(pm[1].replace(/[,.]/g, ""));
        if (p >= 100000 && p <= 500000) prices.push(p);
      }
    }
    
    // Strategy B: JSON-LD structured data
    const jsonLd = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi) || [];
    for (const jm of jsonLd) {
      try {
        const inner = jm.replace(/<script[^>]*>/, "").replace(/<\/script>/i, "").trim();
        const parsed = JSON.parse(inner);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          const op = item.offers?.price || item.offers?.lowPrice;
          if (op) {
            const p = parseInt(String(op).replace(/[,.]/g, ""));
            if (p >= 100000 && p <= 500000) prices.push(p);
          }
          if (item.itemListElement) {
            for (const li of item.itemListElement) {
              const lp = li.item?.offers?.price || li.item?.offers?.lowPrice;
              if (lp) {
                const p = parseInt(String(lp).replace(/[,.]/g, ""));
                if (p >= 100000 && p <= 500000) prices.push(p);
              }
            }
          }
        }
      } catch {}
    }
    
    // Strategy C: __NEXT_DATA__
    const nextData = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextData) {
      try {
        const nd = JSON.parse(nextData[1]);
        const jsonStr = JSON.stringify(nd);
        const priceMatches = jsonStr.match(/"price"\s*:\s*(\d{5,6})/g) || [];
        for (const pm of priceMatches) {
          const val = parseInt(pm.replace(/"price"\s*:\s*/, ""));
          if (val >= 100000 && val <= 500000) prices.push(val);
        }
      } catch {}
    }
    
    // Strategy D: General price regex fallback
    if (prices.length === 0) {
      const regex = /\$\s*([\d]{1,3}(?:[,.]\d{3})+)/g;
      let m;
      while ((m = regex.exec(html)) !== null) {
        const p = parseInt(m[1].replace(/[,.]/g, ""));
        if (p >= 100000 && p <= 500000) prices.push(p);
      }
    }
    
    return [...new Set(prices)]; // deduplicate
  } catch {
    return [];
  }
}

// === MERCADOLIBRE API SCRAPER ===
async function scrapeML(brand: string, model: string, year: number, mlToken: string | null): Promise<number[]> {
  if (!mlToken) return [];
  
  try {
    const query = `${brand} ${model} ${year}`;
    const url = `https://api.mercadolibre.com/sites/MLM/search?q=${encodeURIComponent(query)}&category=MLM1744&limit=50`;
    
    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${mlToken}` },
      signal: AbortSignal.timeout(15000),
    });
    
    if (!res.ok) return [];
    const data = await res.json();
    
    const prices: number[] = [];
    for (const item of (data.results || [])) {
      if (!item.price || item.price < 100000 || item.price > 500000) continue;
      // Filter by exact year
      const yearAttr = item.attributes?.find((a: any) => a.id === "VEHICLE_YEAR");
      if (yearAttr && parseInt(yearAttr.value_name) !== year) continue;
      prices.push(item.price);
    }
    
    return [...new Set(prices)];
  } catch {
    return [];
  }
}

// === MAIN SCRAPER ===
export async function scrapeAllPrices(
  onProgress?: (progress: ScrapeProgress) => void
): Promise<ScrapeProgress> {
  // Get ML token from server
  let mlToken: string | null = null;
  try {
    const tokenRes = await fetch(`${API_BASE}/api/ml/token`);
    const tokenData = await tokenRes.json();
    mlToken = tokenData.token || null;
  } catch {}
  
  const allTargets: { brand: string; model: string; year: number }[] = [];
  for (const t of SCRAPE_TARGETS) {
    for (const y of t.years) {
      allTargets.push({ brand: t.brand, model: t.model, year: y });
    }
  }
  
  const progress: ScrapeProgress = {
    current: 0,
    total: allTargets.length,
    currentModel: "",
    results: [],
    errors: [],
  };
  
  for (const target of allTargets) {
    progress.current++;
    progress.currentModel = `${target.brand} ${target.model} ${target.year}`;
    onProgress?.(progress);
    
    // Scrape both sources in parallel
    const [kavakPrices, mlPrices] = await Promise.all([
      scrapeKavak(target.brand, target.model, target.year),
      scrapeML(target.brand, target.model, target.year, mlToken),
    ]);
    
    const allPrices = [...new Set([...kavakPrices, ...mlPrices])].sort((a, b) => a - b);
    const sources = [
      kavakPrices.length > 0 ? `Kavak(${kavakPrices.length})` : null,
      mlPrices.length > 0 ? `MercadoLibre(${mlPrices.length})` : null,
    ].filter(Boolean).join(", ");
    
    const result: ScrapeResult = {
      brand: target.brand,
      model: target.model,
      year: target.year,
      prices: allPrices,
      sources: sources || "sin datos",
    };
    
    // Save to server cache if we got prices
    if (allPrices.length > 0) {
      try {
        await fetch(`${API_BASE}/api/market-cache`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brand: target.brand,
            model: target.model,
            variant: null,
            year: target.year,
            prices: allPrices,
            sources,
          }),
        });
      } catch (e: any) {
        result.error = `Cache save failed: ${e.message}`;
      }
    } else {
      result.error = "No prices found";
    }
    
    progress.results.push(result);
    if (result.error) progress.errors.push(`${progress.currentModel}: ${result.error}`);
    onProgress?.(progress);
    
    // Small delay to not hammer sources
    await new Promise(r => setTimeout(r, 500));
  }
  
  return progress;
}

export { SCRAPE_TARGETS };
export type { ScrapeProgress, ScrapeResult };
