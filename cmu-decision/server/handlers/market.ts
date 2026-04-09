export class MarketHandler {
  async fetchMarketPrices(
    brand: string,
    model: string,
    year: number,
    variant?: string | null
  ): Promise<{
    avg: number | null;
    min: number | null;
    max: number | null;
    median: number | null;
    count: number;
    sources: string;
    fallback: boolean;
  }> {
    try {
      const r = await fetch("http://localhost:5000/api/cmu/market-prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, model, year, variant }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await r.json();
      const srcList = (data.sources || []).map((s: any) => `${s.name}(${s.count})`).join(", ");
      return {
        avg: data.average || null,
        min: data.min || null,
        max: data.max || null,
        median: data.median || null,
        count: data.count || 0,
        sources: srcList || "sin datos",
        fallback: data.fallback ?? true,
      };
    } catch (e: any) {
      console.error("[Agent] Market prices error:", e.message);
      return {
        avg: null,
        min: null,
        max: null,
        median: null,
        count: 0,
        sources: "error",
        fallback: true
      };
    }
  }
}