import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Car,
  BarChart3,
  ArrowLeft,
  TrendingUp,
  Database,
  Globe,
  Pencil,
} from "lucide-react";
import { Link } from "wouter";
import { useState, useEffect } from "react";
import { apiGetModels, subscribe } from "@/lib/api";
import type { Model } from "@shared/schema";

function formatMXN(value: number): string {
  return `$${value.toLocaleString("es-MX")}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const sourceConfig: Record<string, { icon: typeof Database; label: string; color: string }> = {
  catalog: { icon: Database, label: "Catálogo", color: "text-primary" },
  external: { icon: Globe, label: "Mercado", color: "text-emerald-600 dark:text-emerald-400" },
  manual: { icon: Pencil, label: "Manual", color: "text-amber-600 dark:text-amber-400" },
};

export default function CatalogPage() {
  const [catalog, setCatalog] = useState<Model[]>(() => apiGetModels());

  useEffect(() => {
    const unsubscribe = subscribe(() => {
      setCatalog(apiGetModels());
    });
    return unsubscribe;
  }, []);

  // Group by brand > model+variant
  const grouped = catalog
    ? Object.entries(
        catalog.reduce<Record<string, Model[]>>((acc, m) => {
          const key = `${m.brand} ${m.model}${m.variant ? ` ${m.variant}` : ""}`;
          if (!acc[key]) acc[key] = [];
          acc[key].push(m);
          return acc;
        }, {})
      ).map(([name, items]) => ({
        name,
        items: items.sort((a, b) => a.year - b.year),
      }))
    : [];

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/motor"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="link-back"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Motor CMU
          </Link>
          <div className="w-px h-5 bg-border" />
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-muted-foreground" />
            <span className="font-semibold text-sm">Catálogo CMU</span>
          </div>
        </div>
        <span className="text-xs text-muted-foreground">
          {catalog?.length || 0} modelos
        </span>
      </div>
        {/* Intro */}
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Los valores CMU se cargan del catálogo interno (Matriz Portafolio).
              En una futura iteración, un proceso externo consultará múltiples fuentes
              de mercado (Mercado Libre, Segundamano, etc.), normalizará precios, y
              actualizará los CMU diariamente.
            </p>
          </CardContent>
        </Card>

        {/* Legend */}
        <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><Database className="w-3 h-3 text-primary" /> Catálogo</span>
          <span className="flex items-center gap-1"><Globe className="w-3 h-3 text-emerald-600" /> Mercado (externo)</span>
          <span className="flex items-center gap-1"><Pencil className="w-3 h-3 text-amber-600" /> Manual</span>
        </div>

        {grouped.map((group) => (
          <Card key={group.name}>
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Car className="w-4 h-4 text-muted-foreground" />
                {group.name}
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  Benchmark: {Math.round(group.items[0].purchaseBenchmarkPct * 100)}%
                </Badge>
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs" data-testid={`table-catalog-${group.items[0].slug}`}>
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left py-1.5 pr-3">Año</th>
                      <th className="text-right py-1.5 px-2">CMU</th>
                      <th className="text-right py-1.5 px-2">Min</th>
                      <th className="text-right py-1.5 px-2">Max</th>
                      <th className="text-right py-1.5 px-2">Mediana</th>
                      <th className="text-center py-1.5 px-2">Anuncios</th>
                      <th className="text-center py-1.5 px-2">Fuente</th>
                      <th className="text-right py-1.5 pl-2">Actualizado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((m) => {
                      const src = sourceConfig[m.cmuSource] || sourceConfig.catalog;
                      const SrcIcon = src.icon;
                      return (
                        <tr key={m.id} className="border-b last:border-0">
                          <td className="py-1.5 pr-3 font-medium">{m.year}</td>
                          <td className="text-right py-1.5 px-2 tabular-nums font-semibold">
                            {formatMXN(m.cmu)}
                          </td>
                          <td className="text-right py-1.5 px-2 tabular-nums text-muted-foreground">
                            {m.cmuMin ? formatMXN(m.cmuMin) : "—"}
                          </td>
                          <td className="text-right py-1.5 px-2 tabular-nums text-muted-foreground">
                            {m.cmuMax ? formatMXN(m.cmuMax) : "—"}
                          </td>
                          <td className="text-right py-1.5 px-2 tabular-nums text-muted-foreground">
                            {m.cmuMedian ? formatMXN(m.cmuMedian) : "—"}
                          </td>
                          <td className="text-center py-1.5 px-2 tabular-nums text-muted-foreground">
                            {m.cmuSampleCount ?? "—"}
                          </td>
                          <td className="text-center py-1.5 px-2">
                            <span className={`inline-flex items-center gap-1 ${src.color}`}>
                              <SrcIcon className="w-3 h-3" />
                              <span className="text-[10px]">{src.label}</span>
                            </span>
                          </td>
                          <td className="text-right py-1.5 pl-2 text-muted-foreground">
                            {formatDate(m.cmuUpdatedAt)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        ))}

      <p className="text-[10px] text-muted-foreground text-center pb-2">
        Valores de la Matriz Portafolio CMU — Marzo 2026
      </p>
    </div>
  );
}
