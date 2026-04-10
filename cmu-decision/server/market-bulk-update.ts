/**
 * market-bulk-update.ts
 * Daily bulk update of market prices for ALL models in the CMU catalog.
 *
 * Sources: Seminuevos.com (HTML) + BBVA AutoMarket (GraphQL)
 * Persists: min, max, median, average, sample_count, sources, individual prices
 *
 * Endpoint: POST /api/market-prices/bulk-update
 * Cron: daily at 6am CST (12:00 UTC)
 */

import { neon } from "@neondatabase/serverless";

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
};

interface PriceEntry { price: number; source: string; }

interface ModelResult {
  brand: string;
  model: string;
  variant: string;
  year: number;
  prices: PriceEntry[];
  min: number;
  max: number;
  median: number;
  average: number;
  count: number;
  sources: { name: string; count: number }[];
  errors: string[];
}

// ─── Seminuevos.com scraper ──────────────────────────────────────────────

// Expected price ranges per model family (based on verified references + market data)
const MODEL_PRICE_RANGES: Record<string, [number, number]> = {
  "march": [120000, 280000],
  "aveo": [130000, 280000],
  "kwid": [120000, 250000],
  "i10": [160000, 320000],
  "v-drive": [150000, 300000],
  "versa": [180000, 380000],
  "rio": [180000, 350000],
  "yaris": [180000, 350000],
  "vento": [150000, 300000],
};

function getPriceRange(model: string): [number, number] {
  const key = model.toLowerCase().replace(/\s+/g, "");
  for (const [k, v] of Object.entries(MODEL_PRICE_RANGES)) {
    if (key.includes(k)) return v;
  }
  return [100000, 350000]; // fallback
}

async function scrapeSeminuevos(brand: string, model: string, year: number): Promise<PriceEntry[]> {
  const prices: PriceEntry[] = [];
  try {
    const [minP, maxP] = getPriceRange(model);
    const url = `https://www.seminuevos.com/autos?marca=${encodeURIComponent(brand.toLowerCase())}&modelo=${encodeURIComponent(model.toLowerCase())}&anio=${year}&precio-desde=${minP}&precio-hasta=${maxP}`;
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return prices;
    const html = await res.text();

    // Extract prices from HTML
    const regex = /\$\s*(\d{1,3}(?:,\d{3})+)/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
      const p = parseInt(m[1].replace(/,/g, ""));
      if (p >= minP && p <= maxP) prices.push({ price: p, source: "Seminuevos" });
    }

    // Also try JSON-LD
    const jsonLdMatches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi) || [];
    for (const jm of jsonLdMatches) {
      try {
        const inner = jm.replace(/<script[^>]*>/, "").replace(/<\/script>/i, "").trim();
        const parsed = JSON.parse(inner);
        for (const item of parsed.itemListElement || []) {
          const op = item.item?.offers?.price;
          if (op) {
            const p = typeof op === "number" ? op : parseInt(String(op).replace(/[,.]/g, ""));
            if (p >= minP && p <= maxP) prices.push({ price: p, source: "Seminuevos" });
          }
        }
      } catch {}
    }
  } catch (e: any) {
    console.log(`[BulkUpdate][Seminuevos] ${brand} ${model} ${year}: ${e.message}`);
  }
  return prices;
}

// ─── BBVA AutoMarket scraper ─────────────────────────────────────────────

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
    const yearPrev = String(year - 1);
    const yearNext = String(year + 1);

    const [bbvaMinP, bbvaMaxP] = getPriceRange(model);
    for (const item of items) {
      const p = item?.price_range?.minimum_price?.final_price?.value;
      const name = (item?.name || "").toLowerCase();
      if (p && p >= bbvaMinP && p <= bbvaMaxP) {
        if (name.includes(yearStr) || name.includes(yearPrev) || name.includes(yearNext)) {
          prices.push({ price: Math.round(p), source: "BBVA AutoMarket" });
        }
      }
    }
  } catch (e: any) {
    console.log(`[BulkUpdate][BBVA] ${brand} ${model} ${year}: ${e.message}`);
  }
  return prices;
}

// ─── Stats calculator ────────────────────────────────────────────────────

function filterOutliers(sorted: number[]): number[] {
  if (sorted.length < 4) return sorted;
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return sorted.filter(p => p >= lo && p <= hi);
}

function calcStats(prices: PriceEntry[]): { min: number; max: number; median: number; average: number; count: number } {
  const unique = [...new Set(prices.map(p => p.price))].sort((a, b) => a - b);
  const filtered = filterOutliers(unique);
  if (filtered.length === 0) return { min: 0, max: 0, median: 0, average: 0, count: 0 };
  const min = filtered[0];
  const max = filtered[filtered.length - 1];
  const mid = Math.floor(filtered.length / 2);
  const median = filtered.length % 2 === 0
    ? Math.round((filtered[mid - 1] + filtered[mid]) / 2)
    : filtered[mid];
  const average = Math.round(filtered.reduce((a, b) => a + b, 0) / filtered.length);
  return { min, max, median, average, count: filtered.length };
}

// ─── Main bulk updater ───────────────────────────────────────────────────

export async function bulkUpdateMarketPrices(): Promise<{
  updated: number;
  skipped: number;
  errors: string[];
  results: ModelResult[];
}> {
  const sql = neon(process.env.DATABASE_URL!);
  const startTime = Date.now();

  // 1. Get all models from catalog
  const models = await sql`SELECT DISTINCT brand, model, variant, year FROM models ORDER BY brand, model, year` as any[];
  console.log(`[BulkUpdate] Starting for ${models.length} models`);

  const results: ModelResult[] = [];
  const errors: string[] = [];
  let updated = 0;
  let skipped = 0;

  // 2. Process in batches of 5 (parallel within batch, sequential between batches)
  const BATCH_SIZE = 5;
  for (let i = 0; i < models.length; i += BATCH_SIZE) {
    const batch = models.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (m: any) => {
      const { brand, model, variant, year } = m;
      const label = `${brand} ${model} ${variant || ""} ${year}`.trim();

      try {
        // Scrape both sources in parallel
        const [snPrices, bbvaPrices] = await Promise.all([
          scrapeSeminuevos(brand, model, year),
          scrapeBBVA(brand, model, year),
        ]);

        const allPrices = [...snPrices, ...bbvaPrices];
        const stats = calcStats(allPrices);

        // Build source counts
        const sourceCounts: Record<string, number> = {};
        for (const p of allPrices) {
          sourceCounts[p.source] = (sourceCounts[p.source] || 0) + 1;
        }
        const sources = Object.entries(sourceCounts).map(([name, count]) => ({ name, count }));
        const sourcesStr = sources.map(s => `${s.name}(${s.count})`).join(", ");

        const result: ModelResult = {
          brand, model, variant: variant || "", year,
          prices: allPrices,
          ...stats,
          sources,
          errors: [],
        };

        if (stats.count > 0) {
          // Persist to market_prices_cache
          const sorted = allPrices
            .map(p => ({ price: p.price, source: p.source }))
            .sort((a, b) => a.price - b.price);

          await sql`
            INSERT INTO market_prices_cache (brand, model, variant, year, min_price, max_price, median_price, average_price, sample_count, prices, sources, scraped_at)
            VALUES (${brand}, ${model}, ${variant || ""}, ${year}, ${stats.min}, ${stats.max}, ${stats.median}, ${stats.average}, ${stats.count}, ${JSON.stringify(sorted)}::jsonb, ${sourcesStr}, NOW())
            ON CONFLICT (brand, model, variant, year) DO UPDATE SET
              min_price = ${stats.min}, max_price = ${stats.max},
              median_price = ${stats.median}, average_price = ${stats.average},
              sample_count = ${stats.count}, prices = ${JSON.stringify(sorted)}::jsonb,
              sources = ${sourcesStr}, scraped_at = NOW()
          `;
          updated++;
          console.log(`[BulkUpdate] ✅ ${label}: $${stats.min.toLocaleString()}-$${stats.max.toLocaleString()} (med $${stats.median.toLocaleString()}) [${sourcesStr}]`);
        } else {
          skipped++;
          console.log(`[BulkUpdate] ⏭️ ${label}: no prices found`);
        }

        return result;
      } catch (e: any) {
        errors.push(`${label}: ${e.message}`);
        console.log(`[BulkUpdate] ❌ ${label}: ${e.message}`);
        skipped++;
        return {
          brand, model, variant: variant || "", year,
          prices: [], min: 0, max: 0, median: 0, average: 0, count: 0,
          sources: [], errors: [e.message],
        } as ModelResult;
      }
    }));

    results.push(...batchResults);

    // Small delay between batches to be nice to external APIs
    if (i + BATCH_SIZE < models.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // ─── STEP 3: Update CMU prices in vehicles_inventory ────────────────────
  // PV rule: PV = min(mercado, max(catálogo, mercado × 0.95))
  // "CMU price can NEVER exceed the market average for the equivalent vehicle without GNV"
  console.log(`\n[BulkUpdate] Updating CMU prices in vehicles_inventory...`);
  const cmuUpdates: { id: number; modelo: string; old_cmu: number; new_cmu: number; mercado: number; reason: string }[] = [];

  try {
    const vehicles = await sql`SELECT id, marca, modelo, variante, anio, cmu_valor, costo_adquisicion, costo_reparacion FROM vehicles_inventory WHERE status = 'disponible'` as any[];

    for (const v of vehicles) {
      // Find the matching market cache entry
      const cacheRows = await sql`
        SELECT median_price, average_price, min_price, max_price, sample_count
        FROM market_prices_cache
        WHERE LOWER(brand) = LOWER(${v.marca})
          AND LOWER(model) = LOWER(${v.modelo})
          AND year = ${v.anio}
          AND scraped_at > NOW() - INTERVAL '7 days'
        ORDER BY scraped_at DESC LIMIT 1
      ` as any[];

      if (cacheRows.length === 0) {
        console.log(`[BulkUpdate][CMU] ${v.marca} ${v.modelo} ${v.anio} (id=${v.id}): no recent market data — skipping`);
        continue;
      }

      const cache = cacheRows[0];
      const mercado = cache.median_price;
      const catalogBase = v.cmu_valor || 0; // current CMU price as "catálogo" baseline
      
      // The "catálogo" floor is the acquisition cost + repairs + GNV kit margin
      // But since cmu_valor IS the catalog price, we use it as the floor
      const floor = catalogBase;
      
      // PV = min(mercado, max(catálogo, mercado × 0.95))
      const pv = Math.min(mercado, Math.max(floor, Math.round(mercado * 0.95)));
      
      // Only update if the new PV is different AND the market data has enough samples
      if (cache.sample_count >= 3 && pv !== v.cmu_valor) {
        const old_cmu = v.cmu_valor;
        await sql`UPDATE vehicles_inventory SET cmu_valor = ${pv}, updated_at = NOW() WHERE id = ${v.id}`;
        const reason = pv < old_cmu
          ? `bajó: mercado med $${mercado.toLocaleString()} < CMU anterior $${old_cmu.toLocaleString()}`
          : `subió: mercado med $${mercado.toLocaleString()} > CMU anterior $${old_cmu.toLocaleString()}`;
        cmuUpdates.push({ id: v.id, modelo: `${v.marca} ${v.modelo} ${v.anio}`, old_cmu, new_cmu: pv, mercado, reason });
        console.log(`[BulkUpdate][CMU] ✅ ${v.marca} ${v.modelo} ${v.anio} (id=${v.id}): $${old_cmu.toLocaleString()} → $${pv.toLocaleString()} (mercado med: $${mercado.toLocaleString()})`);
      } else {
        console.log(`[BulkUpdate][CMU] ⏭️ ${v.marca} ${v.modelo} ${v.anio} (id=${v.id}): $${v.cmu_valor?.toLocaleString()} — no change needed (mercado med: $${mercado.toLocaleString()}, samples: ${cache.sample_count})`);
      }
    }
  } catch (e: any) {
    console.error(`[BulkUpdate][CMU] Error updating vehicle prices:`, e.message);
    errors.push(`CMU update: ${e.message}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[BulkUpdate] Done in ${elapsed}s: ${updated} market updated, ${cmuUpdates.length} CMU prices adjusted, ${skipped} skipped, ${errors.length} errors`);

  return { updated, skipped, errors, results, cmuUpdates };
}
