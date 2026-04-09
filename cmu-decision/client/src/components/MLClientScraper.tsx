/**
 * MLClientScraper — Client-side MercadoLibre price scraper
 *
 * Runs IN THE BROWSER from the director's device in Mexico.
 * Bypasses Fly.io datacenter IP blocks by making ML API calls
 * directly from the client, then POSTs results to /api/market-cache.
 *
 * Usage: place anywhere in the director panel. One click fetches
 * prices for all CMU models and caches them server-side.
 */

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { RefreshCw, CheckCircle2, XCircle, Loader2, ShoppingCart } from "lucide-react";

// ─── CMU catalog: models to scrape ───────────────────────────────────────────
const CMU_MODELS = [
  { brand: "Nissan",    model: "March",     variant: "Sense",    year: 2021 },
  { brand: "Nissan",    model: "March",     variant: "Advance",  year: 2021 },
  { brand: "Nissan",    model: "March",     variant: "Sense",    year: 2022 },
  { brand: "Nissan",    model: "March",     variant: "Advance",  year: 2022 },
  { brand: "Nissan",    model: "March",     variant: "Sense",    year: 2023 },
  { brand: "Chevrolet", model: "Aveo",      variant: null,       year: 2021 },
  { brand: "Chevrolet", model: "Aveo",      variant: null,       year: 2022 },
  { brand: "Chevrolet", model: "Aveo",      variant: null,       year: 2023 },
  { brand: "Renault",   model: "Kwid",      variant: null,       year: 2023 },
  { brand: "Renault",   model: "Kwid",      variant: null,       year: 2024 },
  { brand: "Hyundai",   model: "Grand i10", variant: "GL",       year: 2022 },
  { brand: "Hyundai",   model: "Grand i10", variant: "GL",       year: 2023 },
] as const;

// Price sanity bounds (MXN)
const PRICE_MIN = 100_000;
const PRICE_MAX = 450_000;

type ModelEntry = (typeof CMU_MODELS)[number];
type Status = "idle" | "fetching" | "ok" | "error" | "no_results";

interface ModelResult {
  model: ModelEntry;
  status: Status;
  count: number;
  avg?: number;
  min?: number;
  max?: number;
  error?: string;
}

// ─── ML API search (client-side, no auth needed for catalog search) ──────────
async function fetchMLPrices(
  brand: string,
  model: string,
  variant: string | null,
  year: number
): Promise<number[]> {
  const q = [brand, model, variant, String(year)].filter(Boolean).join(" ");
  const url = `https://api.mercadolibre.com/sites/MLM/search?q=${encodeURIComponent(
    q
  )}&category=MLM1744&limit=50`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ML HTTP ${res.status}`);

  const data = await res.json();
  if (data.error) throw new Error(data.message || data.error);

  const prices: number[] = [];
  for (const item of data.results ?? []) {
    const p = Number(item.price);
    if (p >= PRICE_MIN && p <= PRICE_MAX) {
      // Extra filter: item title should contain brand or model
      const title: string = (item.title ?? "").toLowerCase();
      const brandOk = title.includes(brand.toLowerCase().split(" ")[0]);
      const modelOk = title.includes(model.toLowerCase().split(" ")[0]);
      if (brandOk || modelOk) prices.push(p);
    }
  }
  return prices;
}

// ─── Save to server cache ────────────────────────────────────────────────────
async function saveToCache(
  brand: string,
  model: string,
  variant: string | null,
  year: number,
  prices: number[]
): Promise<void> {
  const res = await fetch("/api/market-cache", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      brand,
      model: variant ? `${model} ${variant}` : model,
      variant,
      year,
      prices,
      sources: "MercadoLibre (client)",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Cache save HTTP ${res.status}`);
  }
}

// ─── Component ───────────────────────────────────────────────────────────────
export function MLClientScraper() {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ModelResult[]>([]);
  const [progress, setProgress] = useState(0);

  const handleRun = useCallback(async () => {
    setRunning(true);
    setProgress(0);
    const initial: ModelResult[] = CMU_MODELS.map((m) => ({
      model: m,
      status: "idle",
      count: 0,
    }));
    setResults(initial);

    for (let i = 0; i < CMU_MODELS.length; i++) {
      const m = CMU_MODELS[i];

      // Mark as fetching
      setResults((prev) =>
        prev.map((r, idx) =>
          idx === i ? { ...r, status: "fetching" } : r
        )
      );

      try {
        const prices = await fetchMLPrices(m.brand, m.model, m.variant, m.year);

        if (prices.length === 0) {
          setResults((prev) =>
            prev.map((r, idx) =>
              idx === i ? { ...r, status: "no_results", count: 0 } : r
            )
          );
        } else {
          // Save to server
          await saveToCache(m.brand, m.model, m.variant, m.year, prices);

          const sorted = [...prices].sort((a, b) => a - b);
          const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
          setResults((prev) =>
            prev.map((r, idx) =>
              idx === i
                ? {
                    ...r,
                    status: "ok",
                    count: prices.length,
                    avg,
                    min: sorted[0],
                    max: sorted[sorted.length - 1],
                  }
                : r
            )
          );
        }
      } catch (e: any) {
        setResults((prev) =>
          prev.map((r, idx) =>
            idx === i
              ? { ...r, status: "error", count: 0, error: e.message }
              : r
          )
        );
      }

      setProgress(Math.round(((i + 1) / CMU_MODELS.length) * 100));

      // Small delay to avoid rate limiting
      if (i < CMU_MODELS.length - 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    setRunning(false);
  }, []);

  const done = results.filter((r) => r.status !== "idle" && r.status !== "fetching").length;
  const ok = results.filter((r) => r.status === "ok").length;
  const errors = results.filter((r) => r.status === "error" || r.status === "no_results").length;

  const fmtMXN = (n?: number) =>
    n != null ? `$${n.toLocaleString("es-MX")}` : "—";

  const statusIcon = (s: Status) => {
    if (s === "fetching") return <Loader2 className="w-3 h-3 animate-spin text-blue-500" />;
    if (s === "ok") return <CheckCircle2 className="w-3 h-3 text-emerald-500" />;
    if (s === "error") return <XCircle className="w-3 h-3 text-red-500" />;
    if (s === "no_results") return <XCircle className="w-3 h-3 text-amber-500" />;
    return <div className="w-3 h-3 rounded-full bg-muted-foreground/20" />;
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-[11px] border-blue-200 text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-950/40"
        >
          <ShoppingCart className="w-3.5 h-3.5" />
          Actualizar precios ML
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <ShoppingCart className="w-4 h-4 text-blue-600" />
            Actualizar precios de mercado vía MercadoLibre
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground">
            Corre desde tu dispositivo en México para acceder a ML sin bloqueo de IP.
            Los precios se guardan en caché del servidor.
          </p>
        </DialogHeader>

        <div className="space-y-3 pt-1">
          {/* Run button */}
          <Button
            onClick={handleRun}
            disabled={running}
            size="sm"
            className="w-full gap-2 text-[12px]"
          >
            {running ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            {running
              ? `Consultando ML... (${done}/${CMU_MODELS.length})`
              : results.length > 0
              ? "Volver a actualizar"
              : `Consultar ${CMU_MODELS.length} modelos`}
          </Button>

          {/* Progress bar */}
          {running && (
            <Progress value={progress} className="h-1.5" />
          )}

          {/* Summary badges */}
          {results.length > 0 && !running && (
            <div className="flex gap-2 flex-wrap">
              <Badge variant="outline" className="text-[10px] gap-1 text-emerald-700 border-emerald-200">
                <CheckCircle2 className="w-2.5 h-2.5" />
                {ok} actualizados
              </Badge>
              {errors > 0 && (
                <Badge variant="outline" className="text-[10px] gap-1 text-amber-700 border-amber-200">
                  <XCircle className="w-2.5 h-2.5" />
                  {errors} sin datos
                </Badge>
              )}
            </div>
          )}

          {/* Results table */}
          {results.length > 0 && (
            <div className="rounded-md border divide-y text-[11px]">
              {results.map((r, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-3 py-2"
                >
                  {statusIcon(r.status)}
                  <span className="flex-1 font-medium truncate">
                    {r.model.brand} {r.model.model}
                    {r.model.variant ? ` ${r.model.variant}` : ""}{" "}
                    {r.model.year}
                  </span>
                  {r.status === "ok" && (
                    <span className="text-muted-foreground tabular-nums shrink-0">
                      {r.count} precios · med ~{fmtMXN(r.avg)}
                    </span>
                  )}
                  {r.status === "no_results" && (
                    <span className="text-amber-600 shrink-0">Sin resultados</span>
                  )}
                  {r.status === "error" && (
                    <span className="text-red-500 shrink-0 truncate max-w-[140px]" title={r.error}>
                      {r.error}
                    </span>
                  )}
                  {r.status === "fetching" && (
                    <span className="text-muted-foreground shrink-0">consultando…</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
