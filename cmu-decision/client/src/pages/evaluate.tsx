import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Car,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  BarChart3,
  Calculator,
  Camera,
  Loader2,
  Info,
  History,
  ChevronDown,
  ChevronUp,
  X,
  FileImage,
  Sparkles,
  Globe,
  TrendingUp,
  RefreshCw,
  ArrowDown,
  ArrowUp,
  Fuel,
  Warehouse,
  Package,
  Check,
  ClipboardList,
  FileText,
  Lock,
} from "lucide-react";
import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import type { ModelOption, EvaluationResult, RepairEstimateResult, AmortizationRow } from "@shared/schema";
import { apiGetModelOptions, apiSaveEvaluation, apiListEvaluations, apiFetchMarketPrices, apiUpdateModelCmu, apiCreateVehicle, apiFetchBusinessConfig, subscribe } from "@/lib/api";
import { evaluateOpportunity } from "@/lib/evaluation-engine";
import { STANDARD, maxAdquisicion, maxReparacion, validarCmu, depositoMes3, updateStandardFromConfig } from "@/lib/cmu-standard";
import { jsPDF } from "jspdf";

function formatMXN(value: number): string {
  return `$${value.toLocaleString("es-MX")}`;
}

function formatDateMX(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("es-MX", {
      timeZone: "America/Mexico_City",
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatPctDec(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatK(value: number): string {
  return value >= 1000 ? `$${Math.round(value / 1000)}k` : formatMXN(value);
}

// ===== Decision Card =====
const DECISION_CONFIG = {
  comprar: { icon: CheckCircle2, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950/40", border: "border-emerald-200 dark:border-emerald-800", label: "COMPRAR" },
  viable: { icon: AlertTriangle, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950/40", border: "border-amber-200 dark:border-amber-800", label: "VIABLE" },
  descartar: { icon: XCircle, color: "text-red-600 dark:text-red-400", bg: "bg-red-50 dark:bg-red-950/40", border: "border-red-200 dark:border-red-800", label: "NO COMPRAR" },
};

function TirCard({ label, value, threshold, description }: { label: string; value: number; threshold?: number; description: string }) {
  const isGood = threshold !== undefined ? value >= threshold : true;
  const color = isGood ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
  const bg = isGood ? "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800" : "bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800";
  const icon = isGood ? "🟢" : "🔴";

  return (
    <Card className={`border ${bg}`}>
      <CardContent className="p-3">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-sm">{icon}</span>
          <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
        </div>
        <div className={`text-lg font-bold tabular-nums ${color}`}>
          {formatPctDec(value)}
        </div>
        <p className="text-[9px] text-muted-foreground mt-0.5">{description}</p>
        {threshold !== undefined && (
          <p className="text-[9px] text-muted-foreground">Umbral: {formatPctDec(threshold)}</p>
        )}
      </CardContent>
    </Card>
  );
}

function DecisionCard({ result }: { result: EvaluationResult }) {
  const level = result.decisionLevel;
  const config = DECISION_CONFIG[level] || DECISION_CONFIG.descartar;
  const Icon = config.icon;
  const [showAmortization, setShowAmortization] = useState(false);
  const [showSensitivity, setShowSensitivity] = useState(false);

  return (
    <div className="space-y-4">
      {/* Decision Header */}
      <Card className={`border-2 ${config.border} ${config.bg}`}>
        <CardContent className="p-5">
          <div className="flex items-start gap-4">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${config.bg}`}>
              <Icon className={`w-7 h-7 ${config.color}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h2 className={`text-xl font-bold ${config.color}`} data-testid="text-decision">
                  {result.decision}
                </h2>
                {result.conTanque ? (
                  <Badge variant="secondary" className="text-[10px]">Con tanque</Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-700">Sin tanque (+$9.4k CMU)</Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-explanation">
                {result.explanation}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Core Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">Costo Total</div>
            <div className="text-lg font-semibold tabular-nums" data-testid="text-total-cost">{formatMXN(result.totalCost)}</div>
            <div className="text-[10px] text-muted-foreground">
              Aseg. {formatMXN(result.insurerPrice)} + Rep. {formatMXN(result.repairEstimate)} + Kit {formatMXN(result.kitGnv)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">% Costo / CMU</div>
            <div className={`text-lg font-semibold tabular-nums ${result.costoPctCmu <= 0.62 ? "text-emerald-600" : result.costoPctCmu <= 0.70 ? "text-amber-600" : "text-red-600"}`}>
              {formatPct(result.costoPctCmu)}
            </div>
            <div className="text-[10px] text-muted-foreground">P.Contado: {formatMXN(result.precioContado)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">% Aseg / CMU</div>
            <div className="text-lg font-semibold tabular-nums">
              {formatPct(result.asegPctCmu)}
            </div>
            <div className="text-[10px] text-muted-foreground">Solo aseguradora vs valor</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">Margen Bruto</div>
            <div className={`text-lg font-semibold tabular-nums ${result.margin >= 40000 ? "text-emerald-600" : result.margin >= 25000 ? "text-amber-600" : "text-red-600"}`} data-testid="text-margin">
              {formatMXN(result.margin)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">Venta a Plazos</div>
            <div className="text-lg font-semibold tabular-nums">{formatMXN(result.ventaPlazos)}</div>
            <div className="text-[10px] text-muted-foreground">Suma 36 cuotas (amortización)</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">Cuotas</div>
            <div className="text-sm font-semibold tabular-nums">
              {formatMXN(result.cuotaMes1)} → {formatMXN(result.cuotaMes36)}
            </div>
            <div className="text-[10px] text-muted-foreground">Mes 1 → Mes 36 (decreciente)</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">MOIC</div>
            <div className={`text-lg font-semibold tabular-nums ${result.moic >= 2.0 ? "text-emerald-600" : result.moic >= 1.5 ? "text-amber-600" : "text-red-600"}`}>
              {result.moic.toFixed(2)}x
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <Fuel className="w-3 h-3" /> Diferencial mensual
            </div>
            <div className="text-lg font-semibold tabular-nums">
              {formatMXN(Math.max(0, result.cuotaMes36 - (result.mesGnvCubre ? 0 : STANDARD.gnvRevenueMes)))}
            </div>
            <div className="text-[10px] text-muted-foreground">
              Cuota m36 {formatMXN(result.cuotaMes36)} − GNV {formatMXN(STANDARD.gnvRevenueMes)}
            </div>
            {result.mesGnvCubre && (
              <div className="text-[10px] text-emerald-600 font-medium mt-0.5">GNV cubre cuota desde mes {result.mesGnvCubre}</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Pago extra taxista */}
      <div className="grid grid-cols-2 gap-3">
        <Card className={result.riesgoCliente.diferencialM1 <= result.gastoGasolina ? "border-emerald-200 bg-emerald-50/50" : "border-amber-200 bg-amber-50/50"}>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              Pago extra taxista <span className="text-[9px] bg-slate-100 px-1 rounded">m1</span>
            </div>
            <div className={`text-lg font-bold tabular-nums ${result.riesgoCliente.diferencialM1 === 0 ? "text-emerald-600" : result.riesgoCliente.diferencialM1 <= result.gastoGasolina ? "text-amber-600" : "text-red-600"}`}>
              {result.riesgoCliente.diferencialM1 === 0 ? "GNV cubre" : formatMXN(result.riesgoCliente.diferencialM1) + "/mes"}
            </div>
            <div className="text-[10px] text-muted-foreground">Sobre gasolina que ya gasta</div>
          </CardContent>
        </Card>
        <Card className={result.riesgoCliente.diferencialM3 <= result.gastoGasolina * 0.5 ? "border-emerald-200 bg-emerald-50/50" : result.riesgoCliente.diferencialM3 <= result.gastoGasolina ? "border-amber-200 bg-amber-50/50" : "border-red-200 bg-red-50/50"}>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              Pago extra taxista <span className="text-[9px] bg-slate-100 px-1 rounded">m3+</span>
            </div>
            <div className={`text-lg font-bold tabular-nums ${result.riesgoCliente.diferencialM3 === 0 ? "text-emerald-600" : result.riesgoCliente.diferencialM3 <= result.gastoGasolina ? "text-amber-600" : "text-red-600"}`}>
              {result.riesgoCliente.diferencialM3 === 0 ? "GNV cubre" : formatMXN(result.riesgoCliente.diferencialM3) + "/mes"}
            </div>
            <div className="text-[10px] text-muted-foreground">Umbral: {formatMXN(result.gastoGasolina)} ({result.riesgoCliente.nivel})</div>
          </CardContent>
        </Card>
      </div>

      {/* 3 TIRs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <TirCard
          label="TIR Base"
          value={result.tirBase}
          threshold={0.299}
          description="Todo de golpe día 0. Piso mínimo."
        />
        <TirCard
          label="TIR Operativa"
          value={result.tirOperativa}
          description="Rep+kit día 0, Amex día 50, cuotas día 25."
        />
        <TirCard
          label="TIR Completa"
          value={result.tirCompleta}
          description="Operativa + anticipo $50k mes 2."
        />
      </div>

      {/* Amortization Table Toggle */}
      <Card>
        <CardContent className="p-0">
          <button
            onClick={() => setShowAmortization(!showAmortization)}
            className="flex items-center justify-between w-full p-3 text-left hover:bg-muted/30 transition-colors"
            data-testid="toggle-amortization"
          >
            <span className="text-xs font-medium">Tabla de Amortización (36 meses)</span>
            {showAmortization ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {showAmortization && (
            <div className="px-3 pb-3 overflow-x-auto">
              <table className="w-full text-[10px] tabular-nums">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1 pr-2">Mes</th>
                    <th className="py-1 pr-2 text-right">Saldo</th>
                    <th className="py-1 pr-2 text-right">Capital</th>
                    <th className="py-1 pr-2 text-right">Interés</th>
                    <th className="py-1 pr-2 text-right font-semibold">Cuota</th>
                    <th className="py-1 pr-2 text-right">GNV</th>
                    <th className="py-1 pr-2 text-right">Depósito</th>
                    <th className="py-1 text-right">Fondo</th>
                  </tr>
                </thead>
                <tbody>
                  {result.amortizacionConAnticipo.map((row: AmortizationRow) => (
                    <tr key={row.month} className={`border-b border-border/50 ${row.month === 2 ? "bg-blue-50 dark:bg-blue-950/30" : ""} ${row.depositoTransferencia <= 0 ? "bg-emerald-50/50 dark:bg-emerald-950/20" : ""}`}>
                      <td className="py-1 pr-2 font-medium">{row.month}{row.month === 2 ? " *" : ""}</td>
                      <td className="py-1 pr-2 text-right">{formatMXN(row.saldoInicial)}</td>
                      <td className="py-1 pr-2 text-right">{formatMXN(row.capital)}</td>
                      <td className="py-1 pr-2 text-right">{formatMXN(row.interes)}</td>
                      <td className="py-1 pr-2 text-right font-semibold">{formatMXN(row.cuota)}</td>
                      <td className="py-1 pr-2 text-right text-emerald-600">{formatMXN(row.gnvRevenue)}</td>
                      <td className={`py-1 pr-2 text-right ${row.depositoTransferencia <= 0 ? "text-emerald-600" : "text-muted-foreground"}`}>
                        {formatMXN(row.depositoTransferencia)}
                      </td>
                      <td className="py-1 text-right text-muted-foreground">{formatMXN(row.fondoGarantia)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[9px] text-muted-foreground mt-2">* Mes 2: incluye anticipo a capital $50,000. Cuotas mes 3-36 recalculadas con saldo reducido.</p>
              <p className="text-[9px] text-muted-foreground mt-1">Cuota = Recaudo GNV (sobreprecio litros) + Depósito vía Conekta. Supuesto base: 400 LEQ × $11/LEQ = $4,400/mes. El recaudo real varía según consumo.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sensitivity Toggle */}
      <Card>
        <CardContent className="p-0">
          <button
            onClick={() => setShowSensitivity(!showSensitivity)}
            className="flex items-center justify-between w-full p-3 text-left hover:bg-muted/30 transition-colors"
            data-testid="toggle-sensitivity"
          >
            <span className="text-xs font-medium">Análisis de Sensibilidad (± reparación)</span>
            {showSensitivity ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {showSensitivity && result.sensitivity.length > 0 && (
            <div className="px-3 pb-3 overflow-x-auto">
              <table className="w-full text-[10px] tabular-nums">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1 pr-2">Δ Reparación</th>
                    <th className="py-1 pr-2 text-right">Reparación</th>
                    <th className="py-1 pr-2 text-right">Costo Total</th>
                    <th className="py-1 pr-2 text-right">Margen</th>
                    <th className="py-1 pr-2 text-right">TIR Base</th>
                    <th className="py-1 text-right">Decisión</th>
                  </tr>
                </thead>
                <tbody>
                  {result.sensitivity.map((s, i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td className="py-1 pr-2">{s.repairDelta >= 0 ? "+" : ""}{formatMXN(s.repairDelta)}</td>
                      <td className="py-1 pr-2 text-right">{formatMXN(s.newRepair)}</td>
                      <td className="py-1 pr-2 text-right">{formatMXN(s.newTotalCost)}</td>
                      <td className="py-1 pr-2 text-right">{formatMXN(s.newMargin)}</td>
                      <td className="py-1 pr-2 text-right">{formatPctDec(s.newTirBase)}</td>
                      <td className={`py-1 text-right font-medium ${s.newDecision === "COMPRAR" ? "text-emerald-600" : s.newDecision === "VIABLE" ? "text-amber-600" : "text-red-600"}`}>
                        {s.newDecision}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ===== Photo Repair Estimate Component (Claude Vision via /api/estimate-repair) =====
const API_BASE_REPAIR = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

function PhotoRepairEstimate({ onEstimate }: { onEstimate: (mid: number) => void }) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<string[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [estimateResult, setEstimateResult] = useState<RepairEstimateResult | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const handleFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    const remaining = 6 - images.length;
    const newFiles = Array.from(files).slice(0, remaining);
    for (const file of newFiles) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > 5 * 1024 * 1024) {
        toast({ title: "Imagen muy grande", description: "Máximo 5MB por imagen", variant: "destructive" });
        continue;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        setImages((prev) => [...prev, dataUrl]);
        setPreviews((prev) => [...prev, dataUrl]);
        setEstimateResult(null);
      };
      reader.readAsDataURL(file);
    }
  }, [images.length, toast]);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
    setEstimateResult(null);
  }, []);

  const analyzePhotos = useCallback(async () => {
    if (images.length === 0) return;
    setIsAnalyzing(true);
    try {
      const res = await fetch(`${API_BASE_REPAIR}/api/estimate-repair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Error del servidor" }));
        throw new Error(err.message || "Error al analizar fotos");
      }
      const result: RepairEstimateResult = await res.json();
      setEstimateResult(result);
      onEstimate(result.estimatedRepairMid);
      toast({
        title: `Estimación IA: ${result.severityLabel}`,
        description: `Rango ${formatMXN(result.estimatedRepairMin)} – ${formatMXN(result.estimatedRepairMax)}. Slider ajustado a ${formatMXN(result.estimatedRepairMid)}.`,
      });
    } catch (err: any) {
      console.warn("[Repair Estimate] Backend failed, using fallback:", err.message);
      const baseMid = 12000 + images.length * 3000;
      const fallbackResult: RepairEstimateResult = {
        severity: baseMid > 25000 ? "severo" : baseMid > 15000 ? "medio" : "leve",
        severityLabel: `Daño ${baseMid > 25000 ? "Severo" : baseMid > 15000 ? "Medio" : "Leve"} (estimación local)`,
        estimatedRepairMin: Math.round(baseMid * 0.6 / 1000) * 1000,
        estimatedRepairMax: Math.round(baseMid * 1.5 / 1000) * 1000,
        estimatedRepairMid: Math.round(baseMid / 1000) * 1000,
        confidence: "baja",
        details: `Sin conexión al servidor de IA. Estimación básica basada en ${images.length} foto(s). Ajusta el slider manualmente para mayor precisión.`,
      };
      setEstimateResult(fallbackResult);
      onEstimate(fallbackResult.estimatedRepairMid);
      toast({
        title: `Estimación local: ${fallbackResult.severityLabel}`,
        description: `Backend no disponible. Rango ${formatMXN(fallbackResult.estimatedRepairMin)} – ${formatMXN(fallbackResult.estimatedRepairMax)}.`,
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
    }
  }, [images, onEstimate, toast]);

  const severityColors: Record<string, string> = {
    leve: "text-emerald-600 dark:text-emerald-400",
    medio: "text-amber-600 dark:text-amber-400",
    severo: "text-orange-600 dark:text-orange-400",
    "destrucción_total": "text-red-600 dark:text-red-400",
  };
  const severityBgs: Record<string, string> = {
    leve: "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800",
    medio: "bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800",
    severo: "bg-orange-50 dark:bg-orange-950/40 border-orange-200 dark:border-orange-800",
    "destrucción_total": "bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800",
  };
  const confidenceLabels: Record<string, string> = { alta: "Confianza alta", media: "Confianza media", baja: "Confianza baja" };

  return (
    <div className="space-y-3">
      <button onClick={() => setIsExpanded(!isExpanded)} className="flex items-center justify-between w-full text-left" data-testid="button-toggle-photo-estimate">
        <div className="flex items-center gap-2">
          <Camera className="w-4 h-4 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">Estimación por Fotos</span>
          {estimateResult && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {estimateResult.severityLabel} · {formatMXN(estimateResult.estimatedRepairMid)}
            </Badge>
          )}
        </div>
        {isExpanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
      </button>
      {isExpanded && (
        <div className="space-y-3">
          <input ref={fileInputRef} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={(e) => handleFiles(e.target.files)} data-testid="input-photo-files" />
          <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => handleFiles(e.target.files)} data-testid="input-photo-camera" />
          {images.length === 0 ? (
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => cameraInputRef.current?.click()} className="border-2 border-dashed border-border rounded-lg p-4 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-muted/30 transition-colors" data-testid="button-camera-photos">
                <Camera className="w-6 h-6 text-muted-foreground" />
                <p className="text-xs font-medium text-muted-foreground">Tomar foto</p>
              </button>
              <button onClick={() => fileInputRef.current?.click()} className="border-2 border-dashed border-border rounded-lg p-4 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-muted/30 transition-colors" data-testid="button-gallery-photos">
                <FileImage className="w-6 h-6 text-muted-foreground" />
                <p className="text-xs font-medium text-muted-foreground">Subir imagen</p>
              </button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {previews.map((src, i) => (
                  <div key={i} className="relative group aspect-square rounded-lg overflow-hidden border border-border bg-muted">
                    <img src={src} alt={`Foto ${i + 1}`} className="w-full h-full object-cover" />
                    <button onClick={() => removeImage(i)} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" data-testid={`button-remove-photo-${i}`}>
                      <X className="w-3 h-3 text-white" />
                    </button>
                  </div>
                ))}
                {images.length < 6 && (
                  <div className="flex flex-col gap-1">
                    <button onClick={() => cameraInputRef.current?.click()} className="aspect-square rounded-lg border-2 border-dashed border-border flex items-center justify-center hover:border-primary/50 hover:bg-muted/30 transition-colors" data-testid="button-add-camera-photo">
                      <Camera className="w-4 h-4 text-muted-foreground" />
                    </button>
                    <button onClick={() => fileInputRef.current?.click()} className="aspect-square rounded-lg border-2 border-dashed border-border flex items-center justify-center hover:border-primary/50 hover:bg-muted/30 transition-colors" data-testid="button-add-gallery-photo">
                      <FileImage className="w-4 h-4 text-muted-foreground" />
                    </button>
                  </div>
                )}
              </div>
              <Button variant="outline" size="sm" className="w-full gap-2" onClick={analyzePhotos} disabled={isAnalyzing || images.length === 0} data-testid="button-analyze-photos">
                {isAnalyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                {isAnalyzing ? "Analizando daño con IA..." : `Analizar ${images.length} foto${images.length > 1 ? "s" : ""} con Claude Vision`}
              </Button>
            </>
          )}
          {estimateResult && (
            <div className={`rounded-lg border p-3 space-y-2 ${severityBgs[estimateResult.severity] || "bg-muted border-border"}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-semibold ${severityColors[estimateResult.severity] || "text-foreground"}`}>{estimateResult.severityLabel}</span>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">{confidenceLabels[estimateResult.confidence]}</Badge>
                </div>
                <span className="text-xs font-semibold tabular-nums" data-testid="text-photo-estimate-range">
                  {formatMXN(estimateResult.estimatedRepairMin)} – {formatMXN(estimateResult.estimatedRepairMax)}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed" data-testid="text-photo-estimate-details">{estimateResult.details}</p>
              <p className="text-[10px] text-muted-foreground">
                Slider ajustado a <strong>{formatMXN(estimateResult.estimatedRepairMid)}</strong>. Puedes modificarlo manualmente.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ===== PDF Export =====
function generateEvaluationPdf(r: EvaluationResult) {
  const doc = new jsPDF({ format: "letter", unit: "mm" });
  const W = 215.9, ML = 18, MR = 18, CW = W - ML - MR;
  let y = 18;
  const fmtM = (n: number) => `$${n.toLocaleString("es-MX")}`;
  const fmtP = (n: number) => `${(n * 100).toFixed(1)}%`;

  // Header
  doc.setFont("helvetica", "bold").setFontSize(12);
  doc.text("CONDUCTORES DEL MUNDO, S.A.P.I. DE C.V.", W / 2, y, { align: "center" });
  y += 5;
  doc.setFont("helvetica", "normal").setFontSize(8);
  doc.text("RFC: CMU201119DD6 — Motor CMU: Decisión de Compra v2", W / 2, y, { align: "center" });
  y += 8;

  // Decision banner
  const decColor = r.decision === "COMPRAR" ? [16, 185, 129] : r.decision === "VIABLE" ? [245, 158, 11] : [239, 68, 68];
  doc.setFillColor(decColor[0], decColor[1], decColor[2]);
  doc.roundedRect(ML, y, CW, 14, 2, 2, "F");
  doc.setFont("helvetica", "bold").setFontSize(16).setTextColor(255, 255, 255);
  doc.text(r.decision, W / 2, y + 9, { align: "center" });
  doc.setTextColor(0, 0, 0);
  y += 18;

  // Vehicle info
  doc.setFont("helvetica", "bold").setFontSize(10);
  doc.text(`${r.brand} ${r.model} ${r.variant || ""} ${r.year}`.trim() + (r.conTanque ? " (Con tanque)" : " (Sin tanque)"), ML, y);
  y += 5;
  doc.setFont("helvetica", "normal").setFontSize(8);
  doc.text(r.explanation, ML, y, { maxWidth: CW });
  const expLines = doc.splitTextToSize(r.explanation, CW);
  y += expLines.length * 3.5 + 4;

  // Financial metrics
  doc.setFont("helvetica", "bold").setFontSize(9);
  doc.text("Métricas Financieras", ML, y);
  y += 5;
  const metrics = [
    ["CMU (Valor Mercado)", fmtM(r.cmu)],
    ["Precio Contado" + (r.conTanque ? "" : " (CMU+$9,400)"), fmtM(r.precioContado)],
    ["Precio Aseguradora", fmtM(r.insurerPrice)],
    ["Reparación Estimada", fmtM(r.repairEstimate)],
    ["Kit GNV", fmtM(r.kitGnv) + (r.conTanque ? " (con tanque)" : " (sin tanque)")],
    ["Costo Total", fmtM(r.totalCost)],
    ["% Costo / CMU", fmtP(r.costoPctCmu)],
    ["% Aseg / CMU", fmtP(r.asegPctCmu)],
    ["Margen Bruto", fmtM(r.margin)],
    ["Venta a Plazos (amortización)", fmtM(r.ventaPlazos)],
    ["Cuota Mes 1 / Mes 36", `${fmtM(r.cuotaMes1)} / ${fmtM(r.cuotaMes36)}`],
    ["TIR Base", fmtP(r.tirBase)],
    ["TIR Operativa (Amex+25d)", fmtP(r.tirOperativa)],
    ["TIR Completa (Op+Anticipo)", fmtP(r.tirCompleta)],
    ["MOIC", `${r.moic.toFixed(2)}x`],
    ["Diferencial m36", `${fmtM(Math.max(0, r.cuotaMes36 - 4400))} (Cuota ${fmtM(r.cuotaMes36)} - GNV $4,400)`],
  ];
  doc.setFont("helvetica", "normal").setFontSize(7.5);
  const colW = CW / 2;
  for (let i = 0; i < metrics.length; i++) {
    const row = metrics[i];
    if (i % 2 === 0) {
      doc.setFillColor(245, 245, 245);
      doc.rect(ML, y - 2.5, CW, 5, "F");
    }
    doc.setFont("helvetica", "normal");
    doc.text(row[0], ML + 2, y);
    doc.setFont("helvetica", "bold");
    doc.text(row[1], ML + CW - 2, y, { align: "right" });
    y += 5;
    if (y > 260) { doc.addPage(); y = 18; }
  }
  y += 4;

  // Footer
  const pageCount = doc.getNumberOfPages();
  const now = new Date().toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal").setFontSize(6).setTextColor(150, 150, 150);
    doc.text(
      `Motor CMU v2 — ${r.brand} ${r.model} ${r.year} — ${now} — CONDUCTORES DEL MUNDO — Pág. ${i}/${pageCount}`,
      W / 2, 272, { align: "center" }
    );
    doc.setTextColor(0, 0, 0);
  }

  const slug = `${r.brand}-${r.model}-${r.year}`.replace(/\s+/g, "-").toLowerCase();
  doc.save(`CMU-Evaluacion-${slug}-${r.decision}.pdf`);
}

// ===== Corrida PDF (client-facing) =====
function generateCorridaPdf(r: EvaluationResult, precioContadoOverride?: number) {
  const doc = new jsPDF({ format: "letter", unit: "mm" });
  const W = 215.9, ML = 18, CW = W - ML - 18;
  let y = 18;
  const fmtM = (n: number) => `$${n.toLocaleString("es-MX")}`;
  const pc = precioContadoOverride ?? r.precioContado;

  // Header
  doc.setFont("helvetica", "bold").setFontSize(12);
  doc.text("CONDUCTORES DEL MUNDO, S.A.P.I. DE C.V.", W / 2, y, { align: "center" });
  y += 5;
  doc.setFont("helvetica", "normal").setFontSize(8);
  doc.text("RFC: CMU201119DD6 — Corrida Financiera", W / 2, y, { align: "center" });
  y += 8;

  // Vehicle info
  doc.setFont("helvetica", "bold").setFontSize(11);
  doc.text(`${r.brand} ${r.model} ${r.variant || ""} ${r.year}`.trim(), ML, y);
  y += 8;

  // Key numbers
  doc.setFont("helvetica", "bold").setFontSize(9);
  doc.text("Resumen del Crédito", ML, y);
  y += 5;

  const summary = [
    ["Precio de Contado", fmtM(pc)],
    ["Plazo", "36 meses"],
    ["Tasa de Interés Anual", "29.9%"],
    ["Cuota Mes 1 (máxima)", fmtM(r.cuotaMes1)],
    ["Cuota Mes 36 (mínima)", fmtM(r.cuotaMes36)],
    ["Anticipo a Capital", fmtM(50000) + " (mes 2)"],
    ["Total a Pagar (suma cuotas)", fmtM(r.ventaPlazos)],
    ["Recaudo GNV estimado", "$4,400/mes (400 LEQ × $11)"],
  ];

  doc.setFont("helvetica", "normal").setFontSize(8);
  for (let i = 0; i < summary.length; i++) {
    if (i % 2 === 0) {
      doc.setFillColor(245, 245, 245);
      doc.rect(ML, y - 2.5, CW, 5, "F");
    }
    doc.setFont("helvetica", "normal");
    doc.text(summary[i][0], ML + 2, y);
    doc.setFont("helvetica", "bold");
    doc.text(summary[i][1], ML + CW - 2, y, { align: "right" });
    y += 5;
  }
  y += 6;

  // Amortization table
  doc.setFont("helvetica", "bold").setFontSize(9);
  doc.text("Tabla de Amortización", ML, y);
  y += 5;

  const cols = [12, 28, 22, 22, 25, 22, 25, 24];
  const headers = ["Mes", "Saldo", "Capital", "Interés", "Cuota", "GNV", "Depósito", "Fondo"];
  doc.setFont("helvetica", "bold").setFontSize(6.5);
  let cx = ML;
  headers.forEach((h, i) => { doc.text(h, cx + 1, y); cx += cols[i]; });
  y += 1;
  doc.setDrawColor(180, 180, 180);
  doc.line(ML, y, ML + CW, y);
  y += 3;

  doc.setFont("helvetica", "normal").setFontSize(6.5);
  const schedule = r.amortizacionConAnticipo;
  for (const row of schedule) {
    cx = ML;
    const vals = [
      String(row.month) + (row.month === 2 ? "*" : ""),
      fmtM(row.saldoInicial),
      fmtM(row.capital),
      fmtM(row.interes),
      fmtM(row.cuota),
      fmtM(row.gnvRevenue),
      fmtM(row.depositoTransferencia),
      fmtM(row.fondoGarantia),
    ];
    vals.forEach((val, i) => { doc.text(val, cx + 1, y); cx += cols[i]; });
    y += 3.5;
    if (y > 260) { doc.addPage(); y = 18; }
  }
  y += 3;

  // Notes
  doc.setFont("helvetica", "normal").setFontSize(7);
  doc.text("* Mes 2: incluye anticipo a capital de $50,000. Cuotas mes 3-36 recalculadas.", ML, y);
  y += 3.5;
  doc.text("Cuota = Recaudo GNV (sobreprecio litros) + Depósito vía transferencia/Conekta.", ML, y);
  y += 3.5;
  doc.text("Supuesto GNV base: 400 LEQ × $11/LEQ = $4,400/mes. El recaudo real varía según consumo.", ML, y);

  // Footer
  const pageCount = doc.getNumberOfPages();
  const now = new Date().toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal").setFontSize(6).setTextColor(150, 150, 150);
    doc.text(
      `CMU — Corrida ${r.brand} ${r.model} ${r.year} — ${now} — Pág. ${i}/${pageCount}`,
      W / 2, 272, { align: "center" }
    );
    doc.setTextColor(0, 0, 0);
  }

  const slug = `${r.brand}-${r.model}-${r.year}`.replace(/\s+/g, "-").toLowerCase();
  doc.save(`CMU-Corrida-${slug}.pdf`);
}

// ===== Vehicle Checklist =====
function VehicleChecklist({
  checks,
  onChange,
}: {
  checks: boolean[];
  onChange: (checks: boolean[]) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const items = STANDARD.checksVehiculo;
  const requiredPassed = items.every((item, i) => !item.required || checks[i]);
  const checkedCount = checks.filter(Boolean).length;

  return (
    <div className="space-y-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center justify-between w-full text-left"
        data-testid="toggle-vehicle-checklist"
      >
        <div className="flex items-center gap-2">
          <ClipboardList className="w-4 h-4 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">Checklist Vehículo</span>
          <Badge
            variant={requiredPassed ? "secondary" : "destructive"}
            className="text-[10px] px-1.5 py-0"
          >
            {checkedCount}/{items.length}
          </Badge>
        </div>
        {isExpanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
      </button>
      {isExpanded && (
        <div className="space-y-1.5 pl-1">
          {items.map((item, i) => (
            <label
              key={item.id}
              className="flex items-center gap-2.5 py-1 cursor-pointer group"
              data-testid={`check-${item.id}`}
            >
              <Checkbox
                checked={checks[i]}
                onCheckedChange={(checked) => {
                  const next = [...checks];
                  next[i] = !!checked;
                  onChange(next);
                }}
              />
              <span className={`text-xs ${checks[i] ? "text-foreground" : "text-muted-foreground"}`}>
                {item.label}
              </span>
              {item.required && (
                <Badge variant="outline" className="text-[9px] px-1 py-0 border-red-300 text-red-500 ml-auto">
                  Requerido
                </Badge>
              )}
              {checks[i] && (
                <Check className="w-3.5 h-3.5 text-emerald-500 ml-auto shrink-0" />
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// Module-level cache to persist form state across navigation (survives unmount, not page reload)
let formCache: {
  selectedModelId?: string;
  insurerPrice?: number;
  repairEstimate?: number;
  conTanque?: boolean;
  cmu?: number;
  vehicleChecks?: boolean[];
  result?: EvaluationResult | null;
  marketData?: any;
} = {};

// ===== Main Page =====
export default function EvaluatePage() {
  const { toast } = useToast();
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [cmu, setCmu] = useState<number>(0);
  const [cmuFromCatalog, setCmuFromCatalog] = useState<boolean>(false);
  const [cmuEdited, setCmuEdited] = useState<boolean>(false);
  const [insurerPrice, setInsurerPrice] = useState<number>(0);
  const [repairEstimate, setRepairEstimate] = useState<number>(STANDARD.reparacionMinima);
  const [conTanque, setConTanque] = useState<boolean>(true);
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [isFetchingPrices, setIsFetchingPrices] = useState(false);
  const [marketData, setMarketData] = useState<{
    count: number; min: number | null; max: number | null; median: number | null; average: number | null;
    sources: { name: string; count: number }[];
    prices: { price: number; source: string }[];
    fallback?: boolean; message?: string;
  } | null>(null);
  const [vehicleChecks, setVehicleChecks] = useState<boolean[]>(
    () => STANDARD.checksVehiculo.map(() => false)
  );
  const [corridaPrecioContado, setCorridaPrecioContado] = useState<number>(0);
  const [showCorridaEditor, setShowCorridaEditor] = useState(false);

  const [modelOptions, setModelOptions] = useState<ModelOption[]>(() => apiGetModelOptions());
  const [opportunities, setOpportunities] = useState<any[]>([]);

  // Track whether this is a fresh mount with cached data → skip auto-fetch for the initial model
  const cachedModelIdRef = useRef<string | null>(formCache.selectedModelId || null);

  // Restore form state from module-level cache on mount (survives navigation, not reload)
  useEffect(() => {
    if (formCache.selectedModelId) setSelectedModelId(formCache.selectedModelId);
    if (formCache.insurerPrice) setInsurerPrice(formCache.insurerPrice);
    if (formCache.repairEstimate) setRepairEstimate(formCache.repairEstimate);
    if (formCache.conTanque !== undefined) setConTanque(formCache.conTanque);
    if (formCache.cmu) setCmu(formCache.cmu);
    if (formCache.vehicleChecks) setVehicleChecks(formCache.vehicleChecks);
    if (formCache.result !== undefined) setResult(formCache.result);
    if (formCache.marketData !== undefined) setMarketData(formCache.marketData);
  }, []);

  // Save form state to module-level cache on changes
  useEffect(() => {
    formCache = { selectedModelId, insurerPrice, repairEstimate, conTanque, cmu, vehicleChecks, result, marketData };
  }, [selectedModelId, insurerPrice, repairEstimate, conTanque, cmu, vehicleChecks, result, marketData]);

  useEffect(() => {
    apiListEvaluations().then(setOpportunities).catch(console.error);
    // Sync STANDARD from business_rules SSOT (non-blocking)
    apiFetchBusinessConfig().then(cfg => {
      if (cfg) updateStandardFromConfig(cfg);
    }).catch(console.warn);
    const unsubscribe = subscribe(() => {
      setModelOptions(apiGetModelOptions());
      apiListEvaluations().then(setOpportunities).catch(console.error);
    });
    return unsubscribe;
  }, []);

  const modelGroups = useMemo(() => {
    if (!modelOptions) return [];
    const map = new Map<string, ModelOption[]>();
    for (const m of modelOptions) {
      const key = m.displayName;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    return Array.from(map.entries()).map(([name, opts]) => ({
      name,
      options: opts.sort((a, b) => a.year - b.year),
    }));
  }, [modelOptions]);

  const selectedModel = useMemo(() => {
    if (!modelOptions || !selectedModelId) return null;
    return modelOptions.find((m) => String(m.id) === selectedModelId) || null;
  }, [modelOptions, selectedModelId]);

  // Auto-fetch market prices ref to prevent double-fetch
  const autoFetchedRef = useRef<string>("");

  const handleFetchMarketPrices = useCallback(async () => {
    if (!selectedModel) return;
    setIsFetchingPrices(true);
    setMarketData(null);
    try {
      const data = await apiFetchMarketPrices(
        selectedModel.brand,
        selectedModel.model.replace(/ .*/, ""),
        selectedModel.year,
        selectedModel.variant
      );
      setMarketData(data);
      if (data.median && data.median > 0) {
        const catalogCmu = selectedModel.cmu;
        const marketMedian = data.median;
        const ratio = catalogCmu > 0 ? marketMedian / catalogCmu : 1;
        
        if (ratio > 1.20 || ratio < 0.80 || data.count < 5) {
          // Market data unreliable: >120% or <80% of catalog, or <5 samples
          // Show as reference but keep catalog CMU
          const reason = data.count < 5 ? `Solo ${data.count} muestras` : ratio > 1.20 ? `Supera 120% del cat\u00e1logo` : `Debajo del 80% del cat\u00e1logo`;
          toast({
            title: `Mercado: ${formatMXN(marketMedian)} (referencia)`,
            description: `${data.count} muestras. ${reason} (${formatMXN(catalogCmu)}). CMU no modificado.`,
          });
        } else {
          // Market is reasonable (80%-120% of catalog, 5+ samples) — update CMU
          setCmu(marketMedian);
          setCmuFromCatalog(false);
          setCmuEdited(true);
          setResult(null);
          await apiUpdateModelCmu(selectedModel.id, marketMedian, "mercado", {
            cmuMin: data.min ?? undefined,
            cmuMax: data.max ?? undefined,
            cmuMedian: data.median ?? undefined,
            sampleCount: data.count,
          });
          toast({
            title: `Precio actualizado: ${formatMXN(marketMedian)}`,
            description: `${data.count} muestras de ${data.sources.map((s: any) => s.name).join(", ")}`,
          });
        }
      } else {
        toast({
          title: "Sin resultados de mercado",
          description: data.message || "No se encontraron precios. Intenta con otro modelo.",
          variant: "destructive",
        });
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setIsFetchingPrices(false);
    }
  }, [selectedModel, toast]);

  const handleModelSelect = useCallback((value: string) => {
    setSelectedModelId(value);
    const model = modelOptions?.find((m) => String(m.id) === value);
    if (model && model.cmu > 0) {
      setCmu(model.cmu);
      setCmuFromCatalog(true);
      setCmuEdited(false);
    } else {
      setCmu(0);
      setCmuFromCatalog(false);
      setCmuEdited(false);
    }
    setResult(null);
    setMarketData(null);
    // Only reset checks if model actually changed (not same model re-selected)
    if (value !== selectedModelId) {
      setVehicleChecks(STANDARD.checksVehiculo.map(() => false));
    }
    setShowCorridaEditor(false);
    // Mark for auto-fetch
    autoFetchedRef.current = "";
  }, [modelOptions, selectedModelId]);

  // Auto-fetch market prices when model changes (skip if model was restored from cache)
  useEffect(() => {
    if (!selectedModel) return;
    const modelIdStr = String(selectedModel.id);
    // If this model was restored from formCache, skip the fetch (data already cached)
    if (cachedModelIdRef.current === modelIdStr) {
      autoFetchedRef.current = modelIdStr;
      cachedModelIdRef.current = null; // only skip once
      return;
    }
    if (autoFetchedRef.current !== modelIdStr) {
      autoFetchedRef.current = modelIdStr;
      handleFetchMarketPrices();
    }
  }, [selectedModel, handleFetchMarketPrices]);

  // CMU validation
  const cmuValidation = useMemo(() => {
    if (!cmu || cmu === 0) return null;
    return validarCmu(cmu);
  }, [cmu]);

  // Computed guide values
  const guideMaxAdquisicion = useMemo(() => {
    if (!cmu || cmu === 0) return 0;
    return maxAdquisicion(cmu, conTanque);
  }, [cmu, conTanque]);

  const guideDepositoMes3 = useMemo(() => {
    if (!cmu || cmu === 0) return 0;
    return depositoMes3(cmu, conTanque);
  }, [cmu, conTanque]);

  // Real-time max repair based on insurer price
  const guideMaxReparacion = useMemo(() => {
    if (!cmu || cmu === 0 || !insurerPrice) return 0;
    return maxReparacion(cmu, insurerPrice, conTanque);
  }, [cmu, insurerPrice, conTanque]);

  // Check if insurer price alone exceeds max acquisition
  const insurerExceedsMax = useMemo(() => {
    if (!cmu || cmu === 0 || !insurerPrice) return false;
    return insurerPrice > guideMaxAdquisicion;
  }, [cmu, insurerPrice]);

  // Computed values for preview
  const kitGnv = conTanque ? 18000 : 27400;
  const precioContado = conTanque ? cmu : cmu + 9400;
  const totalCostPreview = insurerPrice + repairEstimate + kitGnv;
  const marginPreview = cmu > 0 ? precioContado - totalCostPreview : 0;
  const costoPctPreview = precioContado > 0 ? totalCostPreview / precioContado : 0;
  const maxRepPreview = useMemo(() => {
    if (!cmu || cmu === 0 || !insurerPrice) return 0;
    return maxReparacion(cmu, insurerPrice, conTanque);
  }, [cmu, insurerPrice, conTanque]);

  // Vehicle checklist validation
  const requiredChecksPassed = useMemo(() => {
    return STANDARD.checksVehiculo.every((item, i) => !item.required || vehicleChecks[i]);
  }, [vehicleChecks]);

  // CMU range validation
  const cmuInRange = useMemo(() => {
    if (!cmu || cmu === 0) return false;
    return cmu >= STANDARD.cmuMinimo && cmu <= STANDARD.cmuMaximo;
  }, [cmu]);

  // Acquisition limit validation
  const acquisitionExceedsMax = useMemo(() => {
    if (!cmu || cmu === 0 || !insurerPrice) return false;
    return (insurerPrice + repairEstimate) > guideMaxAdquisicion;
  }, [cmu, insurerPrice, repairEstimate]);

  // Evaluate button disabled logic — only hard requirements block, everything else is warnings
  const evaluateDisabled = useMemo(() => {
    if (!selectedModel || !insurerPrice || !cmu || isEvaluating) return true;
    if (!requiredChecksPassed) return true;
    // cmuInRange and acquisitionExceedsMax are WARNINGS, not blockers
    return false;
  }, [selectedModel, insurerPrice, cmu, isEvaluating, requiredChecksPassed]);

  // Evaluate disable reason for tooltip
  const evaluateDisableReason = useMemo(() => {
    if (!selectedModel) return "Selecciona un modelo";
    if (!cmu) return "Se requiere un valor CMU";
    if (!insurerPrice) return "Ingresa precio aseguradora";
    if (!requiredChecksPassed) return "Completa los checks requeridos del vehículo";
    return "";
  }, [selectedModel, cmu, insurerPrice, requiredChecksPassed]);

  // Corrida: compute min price where costoPctCmu < noConvienePct (100%)
  // i.e., precioContado must be > totalCost for the deal to not be "NO CONVIENE"
  // For BUEN NEGOCIO: precioContado >= totalCost / buenNegocioPctMax
  const corridaMinPrice = useMemo(() => {
    if (!result) return 0;
    // Min contado price for BUEN NEGOCIO: totalCost / 0.90 = totalCost * 1.111
    return Math.round(result.totalCost / STANDARD.buenNegocioPctMax);
  }, [result]);

  const handleEvaluate = useCallback(async () => {
    if (!selectedModel) {
      toast({ title: "Selecciona un modelo", variant: "destructive" });
      return;
    }
    if (!insurerPrice) {
      toast({ title: "Ingresa el precio de la aseguradora", variant: "destructive" });
      return;
    }
    if (!cmu) {
      toast({ title: "Se requiere un valor CMU", variant: "destructive" });
      return;
    }

    setIsEvaluating(true);
    setTimeout(async () => {
      try {
        console.log("[Evaluate] Starting evaluation...", { model: selectedModel.slug, cmu, insurerPrice, repairEstimate, conTanque });
        const evalResult = evaluateOpportunity(
          {
            modelId: selectedModel.id,
            modelSlug: selectedModel.slug,
            year: selectedModel.year,
            cmu,
            insurerPrice,
            repairEstimate,
            conTanque,
            city: "Aguascalientes",
          },
          {
            brand: selectedModel.brand,
            model: selectedModel.model,
            variant: selectedModel.variant,
            slug: selectedModel.slug,
            purchaseBenchmarkPct: 0.6,
          }
        );

        console.log("[Evaluate] SUCCESS — decision:", evalResult.decision, "guardrails:", evalResult.guardrailsPassed, "/8");
        setResult(evalResult);
        setCorridaPrecioContado(evalResult.precioContado);
        setShowCorridaEditor(false);

        await apiSaveEvaluation({
          modelId: selectedModel.id,
          cmuUsed: cmu,
          insurerPrice,
          repairEstimate,
          totalCost: evalResult.totalCost,
          purchasePct: evalResult.costoPctCmu,
          margin: evalResult.margin,
          tirAnnual: evalResult.tirBase,
          moic: evalResult.moic,
          decision: evalResult.decision,
          decisionLevel: evalResult.decisionLevel,
          explanation: evalResult.explanation,
          city: "Aguascalientes",
        });

        apiListEvaluations().then(setOpportunities).catch(console.error);
      } catch (err: any) {
        console.error("[Evaluate] ERROR:", err);
        toast({ title: "Error en evaluaci\u00f3n", description: err.message || String(err), variant: "destructive" });
      } finally {
        setIsEvaluating(false);
      }
    }, 100);
  }, [selectedModel, insurerPrice, cmu, repairEstimate, conTanque, toast]);

  return (
    <div className="max-w-lg mx-auto space-y-4 pb-8">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">Motor CMU</h1>
            <Badge variant="outline" className="text-[10px]">v2</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Evaluar Oportunidad de Compra
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Sheet open={showHistory} onOpenChange={setShowHistory}>
            <Tooltip>
              <TooltipTrigger asChild>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                    <History className="w-4 h-4" />
                  </Button>
                </SheetTrigger>
              </TooltipTrigger>
              <TooltipContent>Historial</TooltipContent>
            </Tooltip>
            <SheetContent side="right" className="w-[340px] sm:w-[400px] overflow-y-auto">
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2 text-sm">
                  <History className="w-4 h-4" /> Historial de Evaluaciones
                </SheetTitle>
              </SheetHeader>
              <div className="mt-4">
                {(!opportunities || opportunities.length === 0) ? (
                  <div className="text-center text-sm text-muted-foreground py-8">
                    <History className="w-5 h-5 mx-auto mb-2 opacity-50" />
                    Sin evaluaciones guardadas aún.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {opportunities.slice(0, 20).map((opp: any) => {
                      const ts = formatDateMX(opp.created_at || opp.createdAt);
                      return (
                        <div key={opp.id} className="border-b border-border last:border-0 py-2.5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-medium">#{opp.id}</span>
                              <span className={`font-medium px-2 py-0.5 rounded text-[10px] ${
                                opp.decision === "COMPRAR" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                                : opp.decision === "VIABLE" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                                : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
                              }`}>
                                {opp.decision}
                              </span>
                            </div>
                            <span className="text-[10px] text-muted-foreground tabular-nums">{ts}</span>
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            CMU {formatMXN(opp.cmuUsed || opp.cmu_used || 0)} → Costo {formatMXN(opp.totalCost || opp.total_cost || 0)}
                            {opp.margin != null && <span className="ml-1.5">Margen {formatMXN(opp.margin)}</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </SheetContent>
          </Sheet>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link href="/motor/catalog">
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                  <BarChart3 className="w-4 h-4" />
                </Button>
              </Link>
            </TooltipTrigger>
            <TooltipContent>Catálogo</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Evaluation Form */}
      <Card>
        <CardContent className="p-4 space-y-5">
          {/* Model selection */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Modelo y Año</label>
            <Select value={selectedModelId} onValueChange={handleModelSelect}>
              <SelectTrigger data-testid="select-model">
                <SelectValue placeholder="Seleccionar modelo..." />
              </SelectTrigger>
              <SelectContent>
                {modelGroups.map((group) =>
                  group.options.map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>
                      {m.displayName} {m.year} — CMU {formatMXN(m.cmu)}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {/* CMU */}
          {selectedModel && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                CMU / Valor de Mercado (MXN)
              </label>
              <div className="flex gap-2 items-center">
                <Input
                  type="number"
                  value={cmu || ""}
                  onChange={(e) => { setCmu(parseInt(e.target.value) || 0); setCmuEdited(true); setCmuFromCatalog(false); setResult(null); }}
                  onFocus={(e) => e.target.select()}
                  className="flex-1"
                  data-testid="input-cmu"
                />
                {cmuFromCatalog && (
                  <Badge variant="secondary" className="text-[10px] shrink-0">
                    {selectedModel.cmuSource === "catalog" ? "Catálogo CMU" : selectedModel.cmuSource === "manual" ? "Manual" : "Mercado"}
                  </Badge>
                )}
              </div>

              {/* CMU Validation Badge */}
              {cmuValidation && (
                <div className={`mt-1.5 text-[10px] flex items-center gap-1 ${cmuValidation.valid ? "text-emerald-600" : "text-red-600"}`}>
                  {cmuValidation.valid ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                  {cmuValidation.message}
                </div>
              )}

              {/* Market Prices Button + Results */}
              <div className="mt-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-2 text-[11px]"
                  onClick={handleFetchMarketPrices}
                  disabled={isFetchingPrices}
                  data-testid="button-fetch-market-prices"
                >
                  {isFetchingPrices ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Globe className="w-3.5 h-3.5" />
                  )}
                  {isFetchingPrices ? "Consultando Kavak, MercadoLibre..." : "Consultar precios de mercado"}
                </Button>

                {marketData && marketData.count > 0 && (
                  <div className={`mt-2 rounded-lg p-3 ${marketData.fallback ? "bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800" : "bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800"}`} data-testid="market-prices-result">
                    <div className="flex items-center gap-1.5 mb-2">
                      <TrendingUp className={`w-3.5 h-3.5 ${marketData.fallback ? "text-amber-600" : "text-emerald-600"}`} />
                      <span className={`text-xs font-semibold ${marketData.fallback ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>
                        {marketData.count} precios {marketData.fallback ? "(catálogo CMU)" : "encontrados"}
                      </span>
                      <span className={`text-[10px] ml-auto ${marketData.fallback ? "text-amber-600" : "text-emerald-600"}`}>
                        {marketData.sources.map((s: any) => `${s.name} (${s.count})`).join(" · ")}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-center">
                      <div>
                        <p className="text-[10px] text-muted-foreground">Mínimo</p>
                        <p className="text-xs font-bold text-emerald-700 dark:text-emerald-400 flex items-center justify-center gap-0.5">
                          <ArrowDown className="w-2.5 h-2.5" />{formatMXN(marketData.min!)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground">Mediana</p>
                        <p className="text-xs font-bold text-emerald-800 dark:text-emerald-300">{formatMXN(marketData.median!)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground">Promedio</p>
                        <p className="text-xs font-bold tabular-nums">{formatMXN(marketData.average!)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground">Máximo</p>
                        <p className="text-xs font-bold text-amber-600 flex items-center justify-center gap-0.5">
                          <ArrowUp className="w-2.5 h-2.5" />{formatMXN(marketData.max!)}
                        </p>
                      </div>
                    </div>
                    <p className={`text-[9px] mt-2 text-center ${marketData.fallback ? "text-amber-600 dark:text-amber-500" : "text-emerald-600 dark:text-emerald-500"}`}>
                      {marketData.fallback
                        ? "Fuentes externas no disponibles. Datos del catálogo CMU."
                        : "CMU actualizado a mediana de mercado. Puedes editar manualmente."
                      }
                    </p>
                  </div>
                )}

                {marketData && marketData.count === 0 && (
                  <p className="text-[10px] text-amber-600 mt-1">
                    No se encontraron precios de mercado para este modelo. {marketData.message}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* ===== Instant Price Guide Card ===== */}
          {selectedModel && cmu > 0 && (
            <Card className={`border ${cmu > STANDARD.cmuMaximo ? "border-red-300 bg-red-50 dark:bg-red-950/30" : "border-blue-200 bg-blue-50 dark:bg-blue-950/30"}`} data-testid="price-guide-card">
              <CardContent className="p-3 space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <BarChart3 className="w-3.5 h-3.5 text-blue-600" />
                  <span className="text-xs font-semibold text-blue-800 dark:text-blue-300">
                    Guía de Compra — {selectedModel.displayName} {selectedModel.year}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">CMU:</span>
                    <span className="font-semibold tabular-nums">{formatMXN(cmu)}</span>
                    {cmuValidation && (
                      <span className={`text-[9px] ${cmuValidation.valid ? "text-emerald-600" : "text-red-600"}`}>
                        {cmuValidation.valid ? "✓ Dentro del rango" : "✗ Fuera de rango"}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">Máx adquisición:</span>
                    <span className="font-semibold tabular-nums">{formatMXN(guideMaxAdquisicion)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">Rango reparación:</span>
                    <span className="font-semibold tabular-nums">{formatK(STANDARD.reparacionMinima)} - {formatK(STANDARD.reparacionMaxima)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">Depósito mes 3+:</span>
                    <span className={`font-semibold tabular-nums ${guideDepositoMes3 < 0 ? "text-emerald-600" : ""}`}>
                      {guideDepositoMes3 < 0 ? `${formatMXN(0)} (GNV cubre cuota)` : formatMXN(guideDepositoMes3)}
                    </span>
                  </div>
                </div>
                {cmu > STANDARD.cmuMaximo && (
                  <div className="flex items-center gap-1.5 text-red-600 text-[10px] font-medium mt-1 pt-1 border-t border-red-200">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>Valor de mercado ({formatMXN(cmu)}) excede tope del programa ({formatMXN(STANDARD.cmuMaximo)}). Depósito mes 3+: {formatMXN(guideDepositoMes3)} (máx {formatMXN(STANDARD.depositoMaxMes3)}).</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Insurer Price */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Precio Aseguradora (MXN)
            </label>
            <Input
              type="number"
              value={insurerPrice || ""}
              onChange={(e) => { setInsurerPrice(parseInt(e.target.value) || 0); setResult(null); }}
              onFocus={(e) => e.target.select()}
              placeholder="Ej: 120000"
              data-testid="input-insurer-price"
            />
            {/* Real-time feedback on insurer price */}
            {insurerPrice > 0 && cmu > 0 && (
              <div className="mt-1.5 space-y-1">
                <div className="text-[10px] flex items-center gap-1 text-muted-foreground">
                  <Info className="w-3 h-3" />
                  Reparación máxima para COMPRAR: <span className="font-semibold text-foreground tabular-nums">{formatK(guideMaxReparacion)}</span>
                </div>
                {insurerExceedsMax && (
                  <div className="text-[10px] flex items-center gap-1 text-red-600 font-medium">
                    <XCircle className="w-3 h-3" />
                    Precio excede máximo de adquisición ({formatMXN(guideMaxAdquisicion)})
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Repair Estimate with Slider */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-muted-foreground">Reparación Estimada</label>
              <span className="text-xs font-semibold tabular-nums" data-testid="text-repair-estimate">{formatMXN(repairEstimate)}</span>
            </div>
            <Slider
              value={[repairEstimate]}
              min={STANDARD.reparacionMinima}
              max={STANDARD.reparacionMaxima}
              step={1000}
              onValueChange={([v]) => { setRepairEstimate(v); setResult(null); }}
              data-testid="slider-repair"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
              <span>{formatMXN(STANDARD.reparacionMinima)}</span>
              <span>{formatMXN(STANDARD.reparacionMaxima)}</span>
            </div>
          </div>

          {/* Photo-based Repair Estimation */}
          <PhotoRepairEstimate
            onEstimate={(mid) => {
              setRepairEstimate(mid);
              setResult(null);
            }}
          />

          {/* Tank Toggle */}
          <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-2">
              <Fuel className="w-4 h-4 text-muted-foreground" />
              <div>
                <p className="text-xs font-medium">{conTanque ? "Con tanque" : "Sin tanque"}</p>
                <p className="text-[10px] text-muted-foreground">
                  Kit GNV: {formatMXN(kitGnv)}{!conTanque ? " · CMU +$9,400" : ""}
                </p>
              </div>
            </div>
            <Switch
              checked={conTanque}
              onCheckedChange={(v) => { setConTanque(v); setResult(null); }}
              data-testid="switch-tank"
            />
          </div>

          {/* Quick preview */}
          {selectedModel && insurerPrice > 0 && (
            <div className="grid grid-cols-5 gap-2 text-center bg-muted/50 rounded-lg px-3 py-2" data-testid="preview-bar">
              <div>
                <p className="text-[9px] text-muted-foreground">Costo Total</p>
                <p className="text-xs font-bold tabular-nums">{formatMXN(totalCostPreview)}</p>
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground">% CMU</p>
                <p className="text-xs font-bold tabular-nums">{cmu > 0 ? formatPct(costoPctPreview) : "—"}</p>
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground">Margen</p>
                <p className={`text-xs font-bold tabular-nums ${marginPreview >= 40000 ? "text-emerald-600" : marginPreview >= 25000 ? "text-amber-600" : "text-red-600"}`}>
                  {cmu > 0 ? formatMXN(marginPreview) : "—"}
                </p>
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground">Kit GNV</p>
                <p className="text-xs font-bold tabular-nums">{formatMXN(kitGnv)}</p>
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground">Máx rep</p>
                <p className={`text-xs font-bold tabular-nums ${maxRepPreview > 0 ? "text-blue-600" : "text-red-600"}`}>
                  {cmu > 0 ? formatK(maxRepPreview) : "—"}
                </p>
              </div>
            </div>
          )}

          {/* Vehicle Checklist */}
          {selectedModel && (
            <VehicleChecklist
              checks={vehicleChecks}
              onChange={setVehicleChecks}
            />
          )}

          {/* Warnings (non-blocking) */}
          {!cmuInRange && cmu > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <p className="text-[10px]">CMU {formatMXN(cmu)} fuera del rango del programa ({formatMXN(STANDARD.cmuMinimo)}-{formatMXN(STANDARD.cmuMaximo)}). Puedes evaluar de todas formas.</p>
            </div>
          )}
          {acquisitionExceedsMax && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <p className="text-[10px]">Aseg+Rep ({formatMXN(insurerPrice + repairEstimate)}) excede max adquisicion ({formatK(guideMaxAdquisicion)}). Resultado probable: NO COMPRAR.</p>
            </div>
          )}

          {/* Evaluate button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <Button
                  size="lg"
                  className={`w-full gap-2 ${acquisitionExceedsMax && !evaluateDisabled ? "bg-amber-600 hover:bg-amber-700" : ""}`}
                  onClick={handleEvaluate}
                  disabled={evaluateDisabled}
                  data-testid="button-evaluate"
                >
                  {isEvaluating ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Calculator className="w-4 h-4" />
                  )}
                  {isEvaluating ? "Calculando..." : "Evaluar Oportunidad"}
                </Button>
              </div>
            </TooltipTrigger>
            {evaluateDisableReason && (
              <TooltipContent>
                <p className="text-xs">{evaluateDisableReason}</p>
              </TooltipContent>
            )}
          </Tooltip>
        </CardContent>
      </Card>

      {/* Result */}
      {result && (
        <>
          <DecisionCard result={result} />
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              className="gap-2 h-10"
              onClick={() => generateEvaluationPdf(result)}
              data-testid="button-download-evaluation-pdf"
            >
              <ArrowDown className="w-4 h-4" />
              PDF Evaluación
            </Button>
            {(result.decision === "COMPRAR" || result.decision === "VIABLE") && (
              <Button
                className="gap-2 h-10"
                onClick={async () => {
                  if (!selectedModel) return;
                  try {
                    const now = new Date().toISOString();
                    const kitCosto = result.conTanque ? 18000 : 27400;
                    await apiCreateVehicle({
                      marca: result.brand,
                      modelo: result.model,
                      variante: result.variant || null,
                      anio: result.year,
                      color: null,
                      niv: null,
                      placas: null,
                      numSerie: null,
                      numMotor: null,
                      cmuValor: result.cmu,
                      costoAdquisicion: result.insurerPrice,
                      costoReparacion: result.repairEstimate,
                      precioAseguradora: result.insurerPrice,
                      reparacionEstimada: result.repairEstimate,
                      reparacionReal: null,
                      conTanque: result.conTanque ? 1 : 0,
                      margenEstimado: result.margin,
                      tirBaseEstimada: result.tirBase.toFixed(4),
                      evaluationId: null,
                      status: "en_reparacion",
                      assignedOriginationId: null,
                      assignedTaxistaId: null,
                      kitGnvInstalado: 0,
                      kitGnvCosto: kitCosto,
                      kitGnvMarca: null,
                      kitGnvSerie: null,
                      tanqueTipo: result.conTanque ? "reusado" : "nuevo",
                      tanqueMarca: null,
                      tanqueSerie: null,
                      tanqueCosto: null,
                      fotos: null,
                      notes: `Desde Motor CMU: ${result.decision} | Margen ${formatMXN(result.margin)} | TIR Base ${formatPctDec(result.tirBase)}`,
                      createdAt: now,
                      updatedAt: now,
                    });
                    toast({ title: "Enviado a inventario", description: `${result.brand} ${result.model} ${result.year} agregado como 'En Reparación'` });
                  } catch (err: any) {
                    toast({ title: "Error", description: err.message, variant: "destructive" });
                  }
                }}
                data-testid="button-send-to-inventory"
              >
                <Warehouse className="w-4 h-4" />
                Enviar a Inventario
              </Button>
            )}
          </div>

          {/* Corrida Generator */}
          {(result.decision === "COMPRAR" || result.decision === "VIABLE") && (
            <Card data-testid="corrida-section">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Generar Corrida</span>
                </div>

                {!showCorridaEditor ? (
                  <Button
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => {
                      setCorridaPrecioContado(result.precioContado);
                      setShowCorridaEditor(true);
                    }}
                    data-testid="button-open-corrida"
                  >
                    <FileText className="w-4 h-4" />
                    Generar Corrida
                  </Button>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1.5 block flex items-center gap-1">
                        <Lock className="w-3 h-3" />
                        Precio Contado (editable con TIR lock)
                      </label>
                      <Input
                        type="number"
                        value={corridaPrecioContado || ""}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 0;
                          // Enforce TIR lock: cannot go below corridaMinPrice
                          setCorridaPrecioContado(Math.max(val, corridaMinPrice));
                        }}
                        onFocus={(e) => e.target.select()}
                        data-testid="input-corrida-precio"
                      />
                      <div className="flex items-center justify-between mt-1">
                        <p className="text-[10px] text-muted-foreground">
                          Precio mínimo (costo &lt;{Math.round(STANDARD.buenNegocioPctMax * 100)}%): <span className="font-semibold">{formatMXN(corridaMinPrice)}</span>
                        </p>
                        {corridaPrecioContado <= corridaMinPrice && (
                          <Badge variant="destructive" className="text-[9px] px-1.5 py-0">
                            Piso TIR
                          </Badge>
                        )}
                      </div>
                      {corridaPrecioContado < result.precioContado && (
                        <p className="text-[10px] text-amber-600 mt-0.5">
                          Descuento: {formatMXN(result.precioContado - corridaPrecioContado)} ({formatPct((result.precioContado - corridaPrecioContado) / result.precioContado)})
                        </p>
                      )}
                    </div>
                    <Button
                      className="w-full gap-2"
                      onClick={() => generateCorridaPdf(result, corridaPrecioContado !== result.precioContado ? corridaPrecioContado : undefined)}
                      data-testid="button-generate-corrida-pdf"
                    >
                      <ArrowDown className="w-4 h-4" />
                      Descargar Corrida PDF
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* History is now in Sheet (header icon) */}

      {/* Parameters footer */}
      <Card>
        <CardContent className="p-3">
          <p className="text-[10px] text-muted-foreground text-center">
            Tasa {formatPctDec(STANDARD.tasaAnual)} anual | Plazo {STANDARD.plazoMeses} meses | Anticipo {formatMXN(STANDARD.anticipoCapital)} (sem. 8) | GNV {formatMXN(STANDARD.gnvRevenueMes)}/mes | Fondo {formatMXN(STANDARD.fondoInicial)}+{formatMXN(STANDARD.fondoMensual)}/mes | Amex {STANDARD.floatAmexDias}d (solo aseg) | {STANDARD.diasReparacion}d rep + {STANDARD.diasColocacion}d colocación
          </p>
          <p className="text-[9px] text-muted-foreground text-center mt-1">
            CMU: {formatMXN(STANDARD.cmuMinimo)}–{formatMXN(STANDARD.cmuMaximo)} | Rep: {formatMXN(STANDARD.reparacionMinima)}–{formatMXN(STANDARD.reparacionMaxima)} | Kit: {formatMXN(STANDARD.kitConTanque)} / {formatMXN(STANDARD.kitSinTanque)} | GNV: {STANDARD.gnvLeqMes} LEQ × ${STANDARD.gnvPrecioLeq}/LEQ
          </p>
          <p className="text-[9px] text-muted-foreground text-center mt-1">
            Clasificación: &lt;{Math.round(STANDARD.excelentePct * 100)}% = EXCELENTE | {Math.round(STANDARD.buenNegocioPctMin * 100)}-{Math.round(STANDARD.buenNegocioPctMax * 100)}% = BUEN NEGOCIO | {Math.round(STANDARD.marginalPctMin * 100)}-{Math.round(STANDARD.noConvienePct * 100)}% = MARGINAL | &gt;{Math.round(STANDARD.noConvienePct * 100)}% = NO CONVIENE
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
