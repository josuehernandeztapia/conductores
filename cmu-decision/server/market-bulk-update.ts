/**
 * market-bulk-update.ts
 * Daily bulk update of market prices for ALL models in the CMU catalog.
 *
 * PM CMU = P70 del mercado sin GNV, multi-fuente, año exacto, IQR sin outliers.
 * Sources: BBVA AutoMarket (GraphQL) + Autocosmos (Guía Autométrica HTML)
 * Persists: P25, P70, P75, avg_band, sample_count, sources, warnings
 *
 * Endpoint: POST /api/market-prices/bulk-update
 * Cron: daily at 6am CST
 */

import { neon } from "@neondatabase/serverless";

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
};

interface PriceEntry { price: number; source: string; }

interface ModelResult {
  brand: string; model: string; variant: string; year: number;
  prices: PriceEntry[];
  p25: number; p70: number; p75: number; avg_band: number;
  median: number; count: number;
  sources: { name: string; count: number }[];
  sourceCount: number;
  warnings: string[];
  errors: string[];
}

// ─── Price ranges per model family ───────────────────────────────────────────

const MODEL_PRICE_RANGES: Record<string, [number, number]> = {
  "march": [120000, 280000],
  "aveo": [130000, 280000],
  "kwid": [120000, 250000],
  "i10": [140000, 320000],
  "v-drive": [150000, 300000],
  "versa": [180000, 380000],
  "rio": [180000, 350000],
  "yaris": [180000, 350000],
  "vento": [130000, 300000],
};

function getPriceRange(model: string): [number, number] {
  const key = model.toLowerCase().replace(/\s+/g, "");
  for (const [k, v] of Object.entries(MODEL_PRICE_RANGES)) {
    if (key.includes(k)) return v;
  }
  return [100000, 350000];
}

// ─── SOURCE 1: BBVA AutoMarket (GraphQL) ─────────────────────────────────────

async function scrapeBBVA(brand: string, model: string, year: number): Promise<PriceEntry[]> {
  const prices: PriceEntry[] = [];
  try {
    const query = `query { products(filter: { name: { match: "${brand} ${model}" } }, pageSize: 30, sort: { price: ASC }) { total_count items { name price_range { minimum_price { final_price { value } } } } } }`;
    const res = await fetch("https://automarket.bbva.mx/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...FETCH_HEADERS },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return prices;
    const data: any = await res.json();
    const items = data?.data?.products?.items || [];
    const yearStr = String(year);
    const [minP, maxP] = getPriceRange(model);

    for (const item of items) {
      const p = item?.price_range?.minimum_price?.final_price?.value;
      const name = (item?.name || "").toLowerCase();
      if (p && p >= minP && p <= maxP && name.includes(yearStr)) {
        prices.push({ price: Math.round(p), source: "BBVA" });
      }
    }
  } catch (e: any) {
    console.log(`[BulkUpdate][BBVA] ${brand} ${model} ${year}: ${e.message}`);
  }
  return prices;
}

// ─── SOURCE 2: Autocosmos Guía Autométrica ───────────────────────────────────

async function scrapeAutocosmos(brand: string, model: string, year: number): Promise<PriceEntry[]> {
  const prices: PriceEntry[] = [];
  try {
    // Autocosmos URL format: /guiadeprecios/brand/model/year
    const brandSlug = brand.toLowerCase().replace(/\s+/g, "-");
    let modelSlug = model.toLowerCase().replace(/\s+/g, "-");
    // Special cases
    if (modelSlug === "i10" || modelSlug === "grand i10") modelSlug = "grand-i10";
    if (modelSlug.includes("march")) modelSlug = "march";

    const url = `https://www.autocosmos.com.mx/guiadeprecios/${brandSlug}/${modelSlug}/${year}`;
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return prices;
    const html = await res.text();

    // Extract 6-digit prices ($100,000 - $350,000 range)
    const [minP, maxP] = getPriceRange(model);
    const priceRegex = /\$\s*([\d]{1,3},[\d]{3})/g;
    let match;
    const seen = new Set<number>();
    while ((match = priceRegex.exec(html)) !== null) {
      const val = parseInt(match[1].replace(/,/g, ""));
      if (val >= minP && val <= maxP && !seen.has(val)) {
        seen.add(val);
        prices.push({ price: val, source: "Autocosmos" });
      }
    }
  } catch (e: any) {
    console.log(`[BulkUpdate][Autocosmos] ${brand} ${model} ${year}: ${e.message}`);
  }
  return prices;
}

// ─── Stats calculator ────────────────────────────────────────────────────────

function calcPercentile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * percentile));
  return sorted[idx];
}

function calcStats(allPrices: PriceEntry[]): {
  filtered: number[]; p25: number; p70: number; p75: number;
  median: number; avg_band: number; count: number;
} {
  const raw = [...new Set(allPrices.map(p => p.price))].sort((a, b) => a - b);
  if (raw.length < 2) {
    const v = raw[0] || 0;
    return { filtered: raw, p25: v, p70: v, p75: v, median: v, avg_band: v, count: raw.length };
  }

  // IQR outlier removal
  const q1 = raw[Math.floor(raw.length * 0.25)];
  const q3 = raw[Math.floor(raw.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const filtered = raw.filter(p => p >= lo && p <= hi);

  if (filtered.length === 0) {
    return { filtered: raw, p25: raw[0], p70: raw[0], p75: raw[0], median: raw[0], avg_band: raw[0], count: raw.length };
  }

  const p25 = calcPercentile(filtered, 0.25);
  const p70 = calcPercentile(filtered, 0.70);
  const p75 = calcPercentile(filtered, 0.75);
  const mid = Math.floor(filtered.length / 2);
  const median = filtered.length % 2 === 0
    ? Math.round((filtered[mid - 1] + filtered[mid]) / 2)
    : filtered[mid];

  // Average of P25-P75 band only
  const band = filtered.filter(p => p >= p25 && p <= p75);
  const avg_band = band.length > 0
    ? Math.round(band.reduce((a, b) => a + b, 0) / band.length)
    : median;

  return { filtered, p25, p70, p75, median, avg_band, count: filtered.length };
}

function generateWarnings(count: number, sourceCount: number, spread: number): string[] {
  const warnings: string[] = [];
  if (count < 3) warnings.push("SIN_MERCADO: menos de 3 listings — PM no confiable");
  else if (count < 5) warnings.push("MUESTRA_BAJA: solo " + count + " listings — PM poco confiable");
  if (sourceCount === 1) warnings.push("FUENTE_UNICA: sin validación cruzada");
  if (spread > 0.30) warnings.push("MERCADO_DISPERSO: spread P25-P75 > 30%");
  return warnings;
}

// ─── Main bulk updater ───────────────────────────────────────────────────────

export async function bulkUpdateMarketPrices(): Promise<{
  updated: number; skipped: number; errors: string[]; results: ModelResult[];
}> {
  const sql = neon(process.env.DATABASE_URL!);
  const startTime = Date.now();

  const models = await sql`SELECT DISTINCT brand, model, variant, year FROM models ORDER BY brand, model, year` as any[];
  console.log(`[BulkUpdate] Starting for ${models.length} models — PM CMU = P70, multi-source`);

  const results: ModelResult[] = [];
  const errors: string[] = [];
  let updated = 0;
  let skipped = 0;

  const BATCH_SIZE = 5;
  for (let i = 0; i < models.length; i += BATCH_SIZE) {
    const batch = models.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (m: any) => {
      const { brand, model, variant, year } = m;
      const label = `${brand} ${model} ${variant || ""} ${year}`.trim();

      try {
        // Scrape all sources in parallel
        const [bbvaPrices, autocosPrices] = await Promise.all([
          scrapeBBVA(brand, model, year),
          scrapeAutocosmos(brand, model, year),
        ]);

        const allPrices = [...bbvaPrices, ...autocosPrices];
        const stats = calcStats(allPrices);

        // Source counts
        const sourceCounts: Record<string, number> = {};
        for (const p of allPrices) {
          sourceCounts[p.source] = (sourceCounts[p.source] || 0) + 1;
        }
        const sources = Object.entries(sourceCounts).map(([name, count]) => ({ name, count }));
        const sourceCount = Object.keys(sourceCounts).length;
        const sourcesStr = sources.map(s => `${s.name}(${s.count})`).join(", ");

        // Spread check
        const spread = stats.p25 > 0 ? (stats.p75 - stats.p25) / stats.p25 : 0;
        const warnings = generateWarnings(stats.count, sourceCount, spread);

        const result: ModelResult = {
          brand, model, variant: variant || "", year,
          prices: allPrices,
          p25: stats.p25, p70: stats.p70, p75: stats.p75,
          avg_band: stats.avg_band, median: stats.median, count: stats.count,
          sources, sourceCount, warnings, errors: [],
        };

        if (stats.count > 0) {
          const sorted = allPrices
            .map(p => ({ price: p.price, source: p.source }))
            .sort((a, b) => a.price - b.price);

          await sql`
            INSERT INTO market_prices_cache (brand, model, variant, year, min_price, max_price, median_price, average_price, sample_count, prices, sources, p25, p70, p75, avg_band, source_count, warnings, scraped_at)
            VALUES (${brand}, ${model}, ${variant || ""}, ${year}, ${stats.filtered[0] || 0}, ${stats.filtered[stats.filtered.length - 1] || 0}, ${stats.median}, ${stats.avg_band}, ${stats.count}, ${JSON.stringify(sorted)}::jsonb, ${sourcesStr}, ${stats.p25}, ${stats.p70}, ${stats.p75}, ${stats.avg_band}, ${sourceCount}, ${warnings}, NOW())
            ON CONFLICT (brand, model, variant, year) DO UPDATE SET
              min_price = ${stats.filtered[0] || 0}, max_price = ${stats.filtered[stats.filtered.length - 1] || 0},
              median_price = ${stats.median}, average_price = ${stats.avg_band},
              sample_count = ${stats.count}, prices = ${JSON.stringify(sorted)}::jsonb,
              sources = ${sourcesStr}, p25 = ${stats.p25}, p70 = ${stats.p70}, p75 = ${stats.p75},
              avg_band = ${stats.avg_band}, source_count = ${sourceCount}, warnings = ${warnings},
              scraped_at = NOW()
          `;
          updated++;
          const warnStr = warnings.length > 0 ? ` ⚠️ ${warnings.join(", ")}` : "";
          console.log(`[BulkUpdate] ✅ ${label}: P25=$${stats.p25.toLocaleString()} P70=$${stats.p70.toLocaleString()} P75=$${stats.p75.toLocaleString()} Avg=$${stats.avg_band.toLocaleString()} [${sourcesStr}]${warnStr}`);
        } else {
          skipped++;
          console.log(`[BulkUpdate] ⏭️ ${label}: no prices found`);
        }

        return result;
      } catch (e: any) {
        errors.push(`${label}: ${e.message}`);
        skipped++;
        return {
          brand, model, variant: variant || "", year,
          prices: [], p25: 0, p70: 0, p75: 0, avg_band: 0, median: 0, count: 0,
          sources: [], sourceCount: 0, warnings: ["ERROR: " + e.message], errors: [e.message],
        } as ModelResult;
      }
    }));

    results.push(...batchResults);
    if (i + BATCH_SIZE < models.length) await new Promise(r => setTimeout(r, 1000));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[BulkUpdate] Done in ${elapsed}s: ${updated} updated, ${skipped} skipped, ${errors.length} errors`);

  return { updated, skipped, errors, results };
}
