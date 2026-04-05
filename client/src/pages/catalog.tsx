import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Car,
  BarChart3,
  ArrowLeft,
  Database,
  Globe,
  Pencil,
  Plus,
  Save,
  Trash2,
  Loader2,
  CheckCircle2,
  X,
  RefreshCw,
} from "lucide-react";
import { Link } from "wouter";
import { useState, useEffect, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { Progress } from "@/components/ui/progress";
import { apiGetModels, subscribe, updateModel, addModel, deleteModel, apiFetchMarketPrices, apiUpdateModelCmu } from "@/lib/api";
import { scrapeAllPrices, type ScrapeProgress } from "@/lib/price-scraper";
import type { Model } from "@shared/schema";

function formatMXN(value: number): string {
  return `$${value.toLocaleString("es-MX")}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}

const sourceConfig: Record<string, { icon: typeof Database; label: string; color: string }> = {
  catalog: { icon: Database, label: "Catálogo", color: "text-primary" },
  external: { icon: Globe, label: "Mercado", color: "text-emerald-600 dark:text-emerald-400" },
  mercado: { icon: Globe, label: "Mercado", color: "text-emerald-600 dark:text-emerald-400" },
  manual: { icon: Pencil, label: "Manual", color: "text-amber-600 dark:text-amber-400" },
};

// ===== Add Model Dialog =====
function AddModelDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const { toast } = useToast();
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [variant, setVariant] = useState("");
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [cmu, setCmu] = useState<number>(0);
  const [benchmark, setBenchmark] = useState<number>(0.60);

  const handleAdd = () => {
    if (!brand || !model || !year || !cmu) {
      toast({ title: "Completa marca, modelo, año y CMU", variant: "destructive" });
      return;
    }
    const slug = model.toLowerCase().replace(/\s+/g, "-");
    addModel({
      brand, model, variant: variant || null, year, cmu, slug,
      purchaseBenchmarkPct: benchmark,
      cmuSource: "manual",
      cmuUpdatedAt: new Date().toISOString(),
      cmuMin: null, cmuMax: null, cmuMedian: null, cmuSampleCount: null,
    });
    toast({ title: "Modelo agregado", description: `${brand} ${model} ${variant} ${year}` });
    onAdded();
    onClose();
    // Reset form
    setBrand(""); setModel(""); setVariant(""); setCmu(0);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Agregar Modelo al Catálogo</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-muted-foreground mb-1 block">Marca</label>
              <Select value={brand} onValueChange={setBrand}>
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Marca" /></SelectTrigger>
                <SelectContent>
                  {["Chevrolet", "Nissan", "Toyota", "Volkswagen", "Kia", "Hyundai", "Suzuki", "MG"].map(b => (
                    <SelectItem key={b} value={b}>{b}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground mb-1 block">Modelo</label>
              <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="March, Aveo..." className="h-8 text-xs" data-testid="input-add-model" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] text-muted-foreground mb-1 block">Variante</label>
              <Input value={variant} onChange={(e) => setVariant(e.target.value)} placeholder="Sense, Advance" className="h-8 text-xs" />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground mb-1 block">Año</label>
              <Input type="number" value={year} onChange={(e) => setYear(parseInt(e.target.value) || 0)} className="h-8 text-xs" />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground mb-1 block">Benchmark %</label>
              <Input type="number" step="0.01" value={benchmark} onChange={(e) => setBenchmark(parseFloat(e.target.value) || 0.6)} className="h-8 text-xs" />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground mb-1 block">CMU (Valor de Mercado MXN)</label>
            <Input type="number" value={cmu || ""} onChange={(e) => setCmu(parseInt(e.target.value) || 0)} placeholder="200000" className="h-8 text-xs" data-testid="input-add-cmu" />
          </div>
          <Button className="w-full gap-1.5 h-9" onClick={handleAdd} disabled={!brand || !model || !cmu} data-testid="button-add-model">
            <Plus className="w-3.5 h-3.5" />
            Agregar Modelo
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ===== Editable Row =====
function EditableRow({ model: m, onSave, onDelete, onFetchPrices, isFetching }: {
  model: Model;
  onSave: (id: number, cmu: number) => void;
  onDelete: (id: number) => void;
  onFetchPrices: (m: Model) => void;
  isFetching: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editCmu, setEditCmu] = useState(m.cmu);
  const src = sourceConfig[m.cmuSource] || sourceConfig.catalog;
  const SrcIcon = src.icon;

  const handleSave = () => {
    if (editCmu > 0 && editCmu !== m.cmu) {
      onSave(m.id, editCmu);
    }
    setEditing(false);
  };

  return (
    <tr className="border-b last:border-0 group hover:bg-muted/30 transition-colors">
      <td className="py-1.5 pr-2 font-medium text-xs">{m.year}</td>
      <td className="py-1.5 px-2">
        {editing ? (
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">$</span>
            <input
              type="number"
              value={editCmu}
              onChange={(e) => setEditCmu(parseInt(e.target.value) || 0)}
              className="w-20 h-6 text-xs tabular-nums font-semibold bg-background border rounded px-1.5"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setEditing(false); }}
            />
            <button onClick={handleSave} className="text-emerald-600 hover:text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /></button>
            <button onClick={() => setEditing(false)} className="text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
          </div>
        ) : (
          <button
            onClick={() => { setEditCmu(m.cmu); setEditing(true); }}
            className="text-xs tabular-nums font-semibold text-right hover:text-primary transition-colors cursor-pointer"
            title="Click para editar CMU"
            data-testid={`edit-cmu-${m.id}`}
          >
            {formatMXN(m.cmu)}
          </button>
        )}
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums text-[10px] text-muted-foreground">
        {m.cmuMin ? formatMXN(m.cmuMin) : "—"}
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums text-[10px] text-muted-foreground">
        {m.cmuMax ? formatMXN(m.cmuMax) : "—"}
      </td>
      <td className="py-1.5 px-2 text-center tabular-nums text-[10px] text-muted-foreground">
        {m.cmuSampleCount ?? "—"}
      </td>
      <td className="py-1.5 px-2 text-center">
        <span className={`inline-flex items-center gap-0.5 text-[10px] ${src.color}`}>
          <SrcIcon className="w-2.5 h-2.5" />{src.label}
        </span>
        {!m.cmuSampleCount && m.cmuSource === "catalog" && (
          <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-amber-400" title="Sin datos de mercado" />
        )}
      </td>
      <td className="py-1.5 px-2 text-[10px] text-muted-foreground text-right">
        {formatDate(m.cmuUpdatedAt)}
      </td>
      <td className="py-1.5 pl-1">
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onFetchPrices(m)}
            disabled={isFetching}
            className="p-1 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/40 text-muted-foreground hover:text-emerald-600 transition-colors"
            title="Consultar precios de mercado"
          >
            {isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          </button>
          <button
            onClick={() => onDelete(m.id)}
            className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-muted-foreground hover:text-red-600 transition-colors"
            title="Eliminar modelo"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </td>
    </tr>
  );
}

export default function CatalogPage() {
  const { toast } = useToast();
  const [catalog, setCatalog] = useState<Model[]>(() => apiGetModels());
  const [showAdd, setShowAdd] = useState(false);
  const [fetchingId, setFetchingId] = useState<number | null>(null);
  const [scraping, setScraping] = useState(false);
  const [scrapeProgress, setScrapeProgress] = useState<ScrapeProgress | null>(null);

  const handleScrapeAll = useCallback(async () => {
    setScraping(true);
    setScrapeProgress(null);
    toast({ title: "Actualizando precios de mercado...", description: "Consultando Kavak y MercadoLibre desde tu navegador" });
    try {
      const result = await scrapeAllPrices((p) => setScrapeProgress({ ...p }));
      const successCount = result.results.filter(r => r.prices.length > 0).length;
      toast({
        title: `Precios actualizados: ${successCount}/${result.total}`,
        description: `${result.errors.length > 0 ? result.errors.length + " errores" : "Sin errores"}. Datos guardados en cache.`,
      });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setScraping(false);
    }
  }, [toast]);

  useEffect(() => {
    const unsubscribe = subscribe(() => setCatalog(apiGetModels()));
    return unsubscribe;
  }, []);

  const handleSaveCmu = useCallback((id: number, newCmu: number) => {
    updateModel(id, { cmu: newCmu, cmuSource: "manual" });
    toast({ title: "CMU actualizado", description: formatMXN(newCmu) });
  }, [toast]);

  const handleDelete = useCallback((id: number) => {
    const m = catalog.find(c => c.id === id);
    deleteModel(id);
    toast({ title: "Modelo eliminado", description: m ? `${m.brand} ${m.model} ${m.year}` : "" });
  }, [catalog, toast]);

  const handleFetchPrices = useCallback(async (m: Model) => {
    setFetchingId(m.id);
    try {
      const data = await apiFetchMarketPrices(m.brand, m.model, m.year, m.variant);
      if (data.median && data.median > 0) {
        updateModel(m.id, {
          cmu: data.median,
          cmuSource: "mercado",
          cmuMin: data.min,
          cmuMax: data.max,
          cmuMedian: data.median,
          cmuSampleCount: data.count,
        });
        await apiUpdateModelCmu(m.id, data.median, "mercado", {
          cmuMin: data.min ?? undefined,
          cmuMax: data.max ?? undefined,
          cmuMedian: data.median ?? undefined,
          sampleCount: data.count,
        }).catch(() => {});
        toast({ title: `${m.brand} ${m.model} ${m.year}: ${formatMXN(data.median)}`, description: `${data.count} muestras` });
      } else {
        toast({ title: "Sin resultados", description: data.message || "No se encontraron precios", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setFetchingId(null);
    }
  }, [toast]);

  const grouped = catalog
    ? Object.entries(
        catalog.reduce<Record<string, Model[]>>((acc, m) => {
          const key = `${m.brand} ${m.model}${m.variant ? ` ${m.variant}` : ""}`;
          if (!acc[key]) acc[key] = [];
          acc[key].push(m);
          return acc;
        }, {})
      ).map(([name, items]) => ({ name, items: items.sort((a, b) => a.year - b.year) }))
    : [];

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/motor" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="link-back">
            <ArrowLeft className="w-3.5 h-3.5" />
            Motor CMU
          </Link>
          <div className="w-px h-5 bg-border" />
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-muted-foreground" />
            <span className="font-semibold text-sm">Catálogo CMU</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{catalog?.length || 0} modelos</span>
          <Button size="sm" variant="outline" className="gap-1.5 h-7 text-xs" onClick={handleScrapeAll} disabled={scraping} data-testid="button-scrape-prices">
            <RefreshCw className={`w-3 h-3 ${scraping ? "animate-spin" : ""}`} />
            {scraping ? "Actualizando..." : "Actualizar precios"}
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5 h-7 text-xs" onClick={() => setShowAdd(true)} data-testid="button-add-model">
            <Plus className="w-3 h-3" />
            Agregar
          </Button>
        </div>
      </div>

      {/* Scrape progress */}
      {scraping && scrapeProgress && (
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium">Consultando {scrapeProgress.currentModel}...</span>
              <span className="text-xs text-muted-foreground">{scrapeProgress.current}/{scrapeProgress.total}</span>
            </div>
            <Progress value={(scrapeProgress.current / scrapeProgress.total) * 100} className="h-1.5" />
            {scrapeProgress.results.length > 0 && (
              <div className="mt-2 max-h-32 overflow-y-auto text-[10px] space-y-0.5">
                {scrapeProgress.results.slice(-5).map((r, i) => (
                  <div key={i} className={`flex justify-between ${r.prices.length > 0 ? "text-emerald-600" : "text-red-500"}`}>
                    <span>{r.brand} {r.model} {r.year}</span>
                    <span>{r.prices.length > 0 ? `${r.prices.length} precios — ${r.sources}` : r.error || "sin datos"}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><Database className="w-3 h-3 text-primary" /> Catálogo</span>
        <span className="flex items-center gap-1"><Globe className="w-3 h-3 text-emerald-600" /> Mercado</span>
        <span className="flex items-center gap-1"><Pencil className="w-3 h-3 text-amber-600" /> Manual</span>
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Sin muestras</span>
        <span className="ml-auto text-[9px]">Click en precio para editar · Hover para acciones</span>
      </div>

      {grouped.map((group) => (
        <Card key={group.name}>
          <CardContent className="p-3 sm:p-4">
            <h3 className="text-xs sm:text-sm font-semibold mb-3 flex items-center gap-2">
              <Car className="w-4 h-4 text-muted-foreground" />
              {group.name}
              <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
                Benchmark: {Math.round(group.items[0].purchaseBenchmarkPct * 100)}%
              </Badge>
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid={`table-catalog-${group.items[0].slug}`}>
                <thead>
                  <tr className="border-b text-[10px] text-muted-foreground">
                    <th className="text-left py-1 pr-2">Año</th>
                    <th className="text-left py-1 px-2">CMU</th>
                    <th className="text-right py-1 px-2">Min</th>
                    <th className="text-right py-1 px-2">Max</th>
                    <th className="text-center py-1 px-2">Muestras</th>
                    <th className="text-center py-1 px-2">Fuente</th>
                    <th className="text-right py-1 px-2">Actualizado</th>
                    <th className="py-1 w-14"></th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((m) => (
                    <EditableRow
                      key={m.id}
                      model={m}
                      onSave={handleSaveCmu}
                      onDelete={handleDelete}
                      onFetchPrices={handleFetchPrices}
                      isFetching={fetchingId === m.id}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ))}

      <p className="text-[10px] text-muted-foreground text-center pb-2">
        Valores de la Matriz Portafolio CMU — Click en precio para editar
      </p>

      <AddModelDialog open={showAdd} onClose={() => setShowAdd(false)} onAdded={() => {}} />
    </div>
  );
}
