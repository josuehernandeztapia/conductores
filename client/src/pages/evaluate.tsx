import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
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
} from "lucide-react";
import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import type { ModelOption, EvaluationResult, RepairEstimateResult } from "@shared/schema";
import { apiGetModelOptions, apiSaveEvaluation, apiListEvaluations, apiFetchMarketPrices, apiUpdateModelCmu, subscribe } from "@/lib/api";
import { evaluateOpportunity, getThresholds, setThresholds, resetThresholds, type Thresholds } from "@/lib/evaluation-engine";
import { jsPDF } from "jspdf";

function formatMXN(value: number): string {
  return `$${value.toLocaleString("es-MX")}`;
}

function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

const DECISION_CONFIG = {
  optimo: { icon: CheckCircle2, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950/40", border: "border-emerald-200 dark:border-emerald-800", label: "COMPRAR", sublabel: "ÓPTIMO" },
  bueno: { icon: CheckCircle2, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-50 dark:bg-blue-950/40", border: "border-blue-200 dark:border-blue-800", label: "COMPRAR", sublabel: "BUENO" },
  descartar: { icon: XCircle, color: "text-red-600 dark:text-red-400", bg: "bg-red-50 dark:bg-red-950/40", border: "border-red-200 dark:border-red-800", label: "NO COMPRAR", sublabel: "DESCARTAR" },
};

function DecisionCard({ result }: { result: EvaluationResult }) {
  const level = result.decisionLevel;
  const config = DECISION_CONFIG[level] || DECISION_CONFIG.descartar;
  const Icon = result.decision === "DUDOSO" ? AlertTriangle : config.icon;
  const actualColor = result.decision === "DUDOSO" ? "text-amber-600 dark:text-amber-400" : config.color;
  const actualBg = result.decision === "DUDOSO" ? "bg-amber-50 dark:bg-amber-950/40" : config.bg;
  const actualBorder = result.decision === "DUDOSO" ? "border-amber-200 dark:border-amber-800" : config.border;

  const [showCashFlow, setShowCashFlow] = useState(false);

  return (
    <div className="space-y-4">
      {/* Decision Header */}
      <Card className={`border-2 ${actualBorder} ${actualBg}`}>
        <CardContent className="p-5">
          <div className="flex items-start gap-4">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${actualBg}`}>
              <Icon className={`w-7 h-7 ${actualColor}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h2 className={`text-xl font-bold ${actualColor}`} data-testid="text-decision">
                  {result.decision}
                </h2>
                {result.decisionLevel !== "descartar" && (
                  <Badge variant="secondary" className="text-xs">
                    {result.decisionLevel === "optimo" ? "ÓPTIMO" : "BUENO"}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-explanation">
                {result.explanation}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Financial Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">Costo Total</div>
            <div className="text-lg font-semibold tabular-nums" data-testid="text-total-cost">{formatMXN(result.totalCost)}</div>
            <div className="text-[10px] text-muted-foreground">Aseg. {formatMXN(result.insurerPrice)} + Rep. {formatMXN(result.repairEstimate)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">% Compra vs CMU</div>
            <div className={`text-lg font-semibold tabular-nums ${result.purchasePct <= 0.62 ? "text-emerald-600" : result.purchasePct <= 0.68 ? "text-blue-600" : "text-red-600"}`} data-testid="text-pct">
              {formatPct(result.purchasePct)}
            </div>
            <div className="text-[10px] text-muted-foreground">CMU: {formatMXN(result.cmu)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">Margen Bruto</div>
            <div className={`text-lg font-semibold tabular-nums ${result.margin >= 55000 ? "text-emerald-600" : result.margin >= 40000 ? "text-blue-600" : "text-red-600"}`} data-testid="text-margin">
              {formatMXN(result.margin)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">TIR Anual</div>
            <div className={`text-lg font-semibold tabular-nums ${result.tirAnnual >= 1.45 ? "text-emerald-600" : result.tirAnnual >= 0.80 ? "text-blue-600" : "text-red-600"}`} data-testid="text-tir">
              {formatPct(result.tirAnnual)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">MOIC</div>
            <div className={`text-lg font-semibold tabular-nums ${result.moic >= 2.0 ? "text-emerald-600" : result.moic >= 1.5 ? "text-blue-600" : "text-red-600"}`} data-testid="text-moic">
              {result.moic.toFixed(2)}x
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground mb-1">Venta a Plazos</div>
            <div className="text-lg font-semibold tabular-nums" data-testid="text-venta-plazos">{formatMXN(result.ventaPlazos)}</div>
            <div className="text-[10px] text-muted-foreground">Cuota: {formatMXN(result.monthlyPayment)}/mes</div>
          </CardContent>
        </Card>
      </div>

      {/* Sensitivity */}
      <Card>
        <CardContent className="p-4">
          <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-muted-foreground" />
            Sensibilidad (cambio en reparación)
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="table-sensitivity">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left py-1.5 pr-3">Δ Reparación</th>
                  <th className="text-right py-1.5 px-2">Reparación</th>
                  <th className="text-right py-1.5 px-2">Costo Total</th>
                  <th className="text-right py-1.5 px-2">Margen</th>
                  <th className="text-center py-1.5 pl-2">Decisión</th>
                </tr>
              </thead>
              <tbody>
                {result.sensitivity.map((s) => {
                  const isNeg = s.repairDelta < 0;
                  return (
                    <tr key={s.repairDelta} className="border-b last:border-0">
                      <td className={`py-1.5 pr-3 font-medium ${isNeg ? "text-emerald-600" : "text-red-500"}`}>
                        {isNeg ? "" : "+"}{formatMXN(s.repairDelta)}
                      </td>
                      <td className="text-right py-1.5 px-2 tabular-nums">{formatMXN(s.newRepair)}</td>
                      <td className="text-right py-1.5 px-2 tabular-nums">{formatMXN(s.newTotalCost)}</td>
                      <td className="text-right py-1.5 px-2 tabular-nums">{formatMXN(s.newMargin)}</td>
                      <td className="text-center py-1.5 pl-2">
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                          s.newDecision === "COMPRAR" && s.newDecisionLevel === "optimo"
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                            : s.newDecision === "COMPRAR"
                            ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400"
                            : s.newDecision === "DUDOSO"
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                            : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
                        }`}>
                          {s.newDecision}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Cash Flow Toggle */}
      <Card>
        <CardContent className="p-4">
          <button
            onClick={() => setShowCashFlow(!showCashFlow)}
            className="flex items-center justify-between w-full text-sm font-medium"
            data-testid="button-toggle-cashflow"
          >
            <span className="flex items-center gap-2">
              <Calculator className="w-4 h-4 text-muted-foreground" />
              Flujo de Caja (36 meses)
            </span>
            {showCashFlow ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {showCashFlow && (
            <div className="mt-3 overflow-x-auto">
              <div className="text-xs text-muted-foreground mb-2">
                Inversión: {formatMXN(result.totalOutflows)} → Ingresos totales: {formatMXN(result.totalInflows)} → MOIC: {result.moic.toFixed(2)}x
              </div>
              <table className="w-full text-xs" data-testid="table-cashflow">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-1 pr-2">Mes</th>
                    <th className="text-right py-1 px-2">Saldo</th>
                    <th className="text-right py-1 px-2">Cuota</th>
                    <th className="text-right py-1 px-2">GNV</th>
                    <th className="text-right py-1 pl-2">Flujo CMU</th>
                  </tr>
                </thead>
                <tbody>
                  {result.cashFlows.filter((_, i) => i < 6 || i % 3 === 0 || i === result.cashFlows.length - 1).map((cf) => (
                    <tr key={cf.month} className="border-b last:border-0">
                      <td className="py-1 pr-2 font-medium">{cf.month}{cf.month === 2 ? " ←" : ""}</td>
                      <td className="text-right py-1 px-2 tabular-nums">{formatMXN(cf.balance)}</td>
                      <td className="text-right py-1 px-2 tabular-nums">{formatMXN(cf.vehiclePayment)}</td>
                      <td className="text-right py-1 px-2 tabular-nums">{formatMXN(cf.gnvRevenue)}</td>
                      <td className="text-right py-1 pl-2 tabular-nums font-medium text-emerald-600">{formatMXN(cf.netCashFlow)}</td>
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
      // Call the real Claude Vision endpoint
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
      // Fallback: basic estimate based on number of photos (more photos = likely more damage)
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

  const confidenceLabels: Record<string, string> = {
    alta: "Confianza alta",
    media: "Confianza media",
    baja: "Confianza baja",
  };

  return (
    <div className="space-y-3">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center justify-between w-full text-left"
        data-testid="button-toggle-photo-estimate"
      >
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
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
            data-testid="input-photo-files"
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
            data-testid="input-photo-camera"
          />

          {images.length === 0 ? (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => cameraInputRef.current?.click()}
                className="border-2 border-dashed border-border rounded-lg p-4 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-muted/30 transition-colors"
                data-testid="button-camera-photos"
              >
                <Camera className="w-6 h-6 text-muted-foreground" />
                <p className="text-xs font-medium text-muted-foreground">Tomar foto</p>
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-border rounded-lg p-4 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-muted/30 transition-colors"
                data-testid="button-gallery-photos"
              >
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
                    <button
                      onClick={() => removeImage(i)}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      data-testid={`button-remove-photo-${i}`}
                    >
                      <X className="w-3 h-3 text-white" />
                    </button>
                  </div>
                ))}
                {images.length < 6 && (
                  <div className="flex flex-col gap-1">
                    <button
                      onClick={() => cameraInputRef.current?.click()}
                      className="aspect-square rounded-lg border-2 border-dashed border-border flex items-center justify-center hover:border-primary/50 hover:bg-muted/30 transition-colors"
                      data-testid="button-add-camera-photo"
                    >
                      <Camera className="w-4 h-4 text-muted-foreground" />
                    </button>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="aspect-square rounded-lg border-2 border-dashed border-border flex items-center justify-center hover:border-primary/50 hover:bg-muted/30 transition-colors"
                      data-testid="button-add-gallery-photo"
                    >
                      <FileImage className="w-4 h-4 text-muted-foreground" />
                    </button>
                  </div>
                )}
              </div>

              <Button
                variant="outline"
                size="sm"
                className="w-full gap-2"
                onClick={analyzePhotos}
                disabled={isAnalyzing || images.length === 0}
                data-testid="button-analyze-photos"
              >
                {isAnalyzing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                {isAnalyzing ? "Analizando daño con IA..." : `Analizar ${images.length} foto${images.length > 1 ? "s" : ""} con Claude Vision`}
              </Button>
            </>
          )}

          {estimateResult && (
            <div className={`rounded-lg border p-3 space-y-2 ${severityBgs[estimateResult.severity] || "bg-muted border-border"}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-semibold ${severityColors[estimateResult.severity] || "text-foreground"}`}>
                    {estimateResult.severityLabel}
                  </span>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    {confidenceLabels[estimateResult.confidence]}
                  </Badge>
                </div>
                <span className="text-xs font-semibold tabular-nums" data-testid="text-photo-estimate-range">
                  {formatMXN(estimateResult.estimatedRepairMin)} – {formatMXN(estimateResult.estimatedRepairMax)}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed" data-testid="text-photo-estimate-details">
                {estimateResult.details}
              </p>
              <p className="text-[10px] text-muted-foreground">
                Slider ajustado a <strong>{formatMXN(estimateResult.estimatedRepairMid)}</strong>. Puedes modificarlo manualmente si prefieres otro valor.
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
  doc.text("RFC: CMU201119DD6 — Motor CMU: Decisión de Compra", W / 2, y, { align: "center" });
  y += 8;

  // Decision banner
  const decColor = r.decision === "COMPRAR" ? [16, 185, 129] : r.decision === "DUDOSO" ? [245, 158, 11] : [239, 68, 68];
  doc.setFillColor(decColor[0], decColor[1], decColor[2]);
  doc.roundedRect(ML, y, CW, 14, 2, 2, "F");
  doc.setFont("helvetica", "bold").setFontSize(16).setTextColor(255, 255, 255);
  doc.text(r.decision, W / 2, y + 9, { align: "center" });
  if (r.decisionLevel !== "descartar") {
    doc.setFontSize(8);
    doc.text(r.decisionLevel === "optimo" ? "ÓPTIMO" : "BUENO", W / 2, y + 12.5, { align: "center" });
  }
  doc.setTextColor(0, 0, 0);
  y += 18;

  // Vehicle info
  doc.setFont("helvetica", "bold").setFontSize(10);
  doc.text(`${r.brand} ${r.model} ${r.variant || ""} ${r.year}`.trim(), ML, y);
  y += 5;
  doc.setFont("helvetica", "normal").setFontSize(8);
  doc.text(r.explanation, ML, y, { maxWidth: CW });
  const expLines = doc.splitTextToSize(r.explanation, CW);
  y += expLines.length * 3.5 + 4;

  // Financial metrics table
  doc.setFont("helvetica", "bold").setFontSize(9);
  doc.text("Métricas Financieras", ML, y);
  y += 5;

  const metrics = [
    ["CMU (Valor Mercado)", fmtM(r.cmu)],
    ["Precio Aseguradora", fmtM(r.insurerPrice)],
    ["Reparación Estimada", fmtM(r.repairEstimate)],
    ["Costo Total", fmtM(r.totalCost)],
    ["% Compra vs CMU", fmtP(r.purchasePct)],
    ["Margen Bruto", fmtM(r.margin)],
    ["TIR Anual", fmtP(r.tirAnnual)],
    ["MOIC", `${r.moic.toFixed(2)}x`],
    ["Venta a Plazos (markup ×1.237)", fmtM(r.ventaPlazos)],
    ["Mensualidad (36 meses)", `${fmtM(r.monthlyPayment)}/mes`],
  ];

  doc.setFont("helvetica", "normal").setFontSize(7.5);
  const colW = CW / 2;
  for (let i = 0; i < metrics.length; i++) {
    const row = metrics[i];
    const bgY = y - 2.5;
    if (i % 2 === 0) {
      doc.setFillColor(245, 245, 245);
      doc.rect(ML, bgY, CW, 5, "F");
    }
    doc.setFont("helvetica", "normal");
    doc.text(row[0], ML + 2, y);
    doc.setFont("helvetica", "bold");
    doc.text(row[1], ML + CW - 2, y, { align: "right" });
    y += 5;
  }
  y += 4;

  // Sensitivity table
  if (r.sensitivity.length > 0) {
    doc.setFont("helvetica", "bold").setFontSize(9);
    doc.text("Análisis de Sensibilidad", ML, y);
    y += 5;

    doc.setFont("helvetica", "bold").setFontSize(6.5);
    const sCols = [15, 25, 25, 22, 18, 22, 22, 30];
    const sHeaders = ["Δ Rep.", "Reparación", "Costo Total", "% CMU", "Margen", "TIR", "MOIC", "Decisión"];
    let sx = ML;
    sHeaders.forEach((h, i) => { doc.text(h, sx + 1, y); sx += sCols[i]; });
    y += 1;
    doc.setDrawColor(180, 180, 180);
    doc.line(ML, y, ML + CW, y);
    y += 3;

    doc.setFont("helvetica", "normal").setFontSize(6.5);
    for (const s of r.sensitivity) {
      sx = ML;
      const vals = [
        `${s.repairDelta >= 0 ? "+" : ""}${fmtM(s.repairDelta)}`,
        fmtM(s.repair), fmtM(s.totalCost), fmtP(s.purchasePct),
        fmtM(s.margin), fmtP(s.tirAnnual), `${s.moic.toFixed(2)}x`, s.decision,
      ];
      vals.forEach((v, i) => { doc.text(v, sx + 1, y); sx += sCols[i]; });
      y += 3.5;
      if (y > 260) { doc.addPage(); y = 18; }
    }
    y += 4;
  }

  // Footer
  const pageCount = doc.getNumberOfPages();
  const now = new Date().toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal").setFontSize(6).setTextColor(150, 150, 150);
    doc.text(
      `Motor CMU — ${r.brand} ${r.model} ${r.year} — Generado ${now} — CONDUCTORES DEL MUNDO — Pág. ${i}/${pageCount}`,
      W / 2, 272, { align: "center" }
    );
    doc.setTextColor(0, 0, 0);
  }

  // Download
  const slug = `${r.brand}-${r.model}-${r.year}`.replace(/\s+/g, "-").toLowerCase();
  doc.save(`CMU-Evaluacion-${slug}-${r.decision}.pdf`);
}

export default function EvaluatePage() {
  const { toast } = useToast();
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [cmu, setCmu] = useState<number>(0);
  const [cmuFromCatalog, setCmuFromCatalog] = useState<boolean>(false);
  const [cmuEdited, setCmuEdited] = useState<boolean>(false);
  const [insurerPrice, setInsurerPrice] = useState<number>(0);
  const [repairEstimate, setRepairEstimate] = useState<number>(15000);
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [isFetchingPrices, setIsFetchingPrices] = useState(false);
  const [thresholdState, setThresholdState] = useState<Thresholds>(() => getThresholds());
  const handleThresholdChange = useCallback((partial: Partial<Thresholds>) => {
    setThresholds(partial);
    setThresholdState(getThresholds());
    setResult(null); // Clear result so next eval uses new thresholds
  }, []);
  const [marketData, setMarketData] = useState<{
    count: number; min: number | null; max: number | null; median: number | null; average: number | null;
    sources: { name: string; count: number }[];
    prices: { price: number; source: string }[];
  } | null>(null);

  // Model options — sync from storage, reactive via subscribe
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(() => apiGetModelOptions());
  const [opportunities, setOpportunities] = useState<any[]>([]);

  useEffect(() => {
    // Load evaluations
    apiListEvaluations().then(setOpportunities).catch(console.error);

    // Subscribe to in-memory store changes
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
  }, [modelOptions]);

  const handleFetchMarketPrices = useCallback(async () => {
    if (!selectedModel) return;
    setIsFetchingPrices(true);
    setMarketData(null);
    try {
      const data = await apiFetchMarketPrices(
        selectedModel.brand,
        selectedModel.model.replace(/ .*/, ""), // Use base model name (e.g. "March" not "March Sense")
        selectedModel.year,
        selectedModel.variant
      );
      setMarketData(data);
      if (data.median && data.median > 0) {
        setCmu(data.median);
        setCmuFromCatalog(false);
        setCmuEdited(true);
        setResult(null);
        // Update the model in catalog
        await apiUpdateModelCmu(selectedModel.id, data.median, "mercado", {
          cmuMin: data.min ?? undefined,
          cmuMax: data.max ?? undefined,
          cmuMedian: data.median ?? undefined,
          sampleCount: data.count,
        });
        toast({
          title: `Precio actualizado: ${formatMXN(data.median)}`,
          description: `${data.count} muestras de ${data.sources.map(s => s.name).join(", ")}`,
        });
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

    // Run evaluation locally (synchronous but we add a tiny delay for UX)
    setTimeout(async () => {
      try {
        const evalResult = evaluateOpportunity(
          {
            modelId: selectedModel.id,
            modelSlug: selectedModel.slug,
            year: selectedModel.year,
            cmu,
            insurerPrice,
            repairEstimate,
            city: "Aguascalientes",
          },
          {
            brand: selectedModel.brand,
            model: selectedModel.model,
            variant: selectedModel.variant,
            slug: selectedModel.slug,
            purchaseBenchmarkPct: 0.6, // default
          }
        );

        setResult(evalResult);

        // Save via API (falls back to in-memory store automatically)
        await apiSaveEvaluation({
          modelId: selectedModel.id,
          cmuUsed: cmu,
          insurerPrice,
          repairEstimate,
          totalCost: evalResult.totalCost,
          purchasePct: evalResult.purchasePct,
          margin: evalResult.margin,
          tirAnnual: evalResult.tirAnnual,
          moic: evalResult.moic,
          decision: evalResult.decision,
          decisionLevel: evalResult.decisionLevel,
          explanation: evalResult.explanation,
          city: "Aguascalientes",
        });

        // Refresh evaluations list
        apiListEvaluations().then(setOpportunities).catch(console.error);
      } catch (err: any) {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      } finally {
        setIsEvaluating(false);
      }
    }, 100);
  }, [selectedModel, insurerPrice, cmu, repairEstimate, toast]);

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Car className="w-5 h-5 text-muted-foreground" />
          <div>
            <h1 className="text-sm font-semibold">Motor CMU</h1>
            <p className="text-[10px] text-muted-foreground">Decisión de Compra — Siniestrados</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/motor/catalog" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="link-catalog">
            <BarChart3 className="w-3.5 h-3.5" />
            Catálogo
          </Link>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="button-toggle-history"
          >
            <History className="w-3.5 h-3.5" />
            {opportunities?.length || 0}
          </button>
        </div>
      </div>

      {/* Evaluation Form */}
      <Card>
        <CardContent className="p-5 space-y-5">
          <h2 className="text-sm font-medium flex items-center gap-2">
            <Calculator className="w-4 h-4 text-muted-foreground" />
            Evaluar Oportunidad
          </h2>

          {/* Model selection */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Modelo y Año</label>
            <Select value={selectedModelId} onValueChange={handleModelSelect}>
              <SelectTrigger className="h-10" data-testid="select-model">
                <SelectValue placeholder="Selecciona modelo..." />
              </SelectTrigger>
              <SelectContent>
                {modelGroups.map((group) =>
                  group.options.map((opt) => (
                    <SelectItem key={opt.id} value={String(opt.id)}>
                      {opt.displayName} {opt.year} — {opt.brand}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {/* CMU */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                CMU (Valor de Mercado)
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="w-3 h-3 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent className="text-xs max-w-xs">
                    Precio de contado de mercado. Se prellena del catálogo, pero puedes editarlo si tienes un valor más reciente.
                  </TooltipContent>
                </Tooltip>
              </label>
              {cmuFromCatalog && !cmuEdited && selectedModel && (
                <span className="text-[10px] text-primary font-medium">
                  {selectedModel.cmuSource === "catalog" ? "Catálogo CMU" : selectedModel.cmuSource === "manual" ? "Manual" : "Mercado"}
                  {selectedModel.cmuUpdatedAt && (
                    <span className="text-muted-foreground font-normal ml-1">
                      · {new Date(selectedModel.cmuUpdatedAt).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" })}
                    </span>
                  )}
                </span>
              )}
              {cmuEdited && (
                <button
                  type="button"
                  className="text-[10px] text-primary hover:underline font-medium"
                  onClick={() => {
                    const model = modelOptions?.find((m) => String(m.id) === selectedModelId);
                    if (model && model.cmu > 0) {
                      setCmu(model.cmu);
                      setCmuEdited(false);
                      setResult(null);
                    }
                  }}
                  data-testid="button-reset-cmu"
                >
                  Restaurar catálogo
                </button>
              )}
            </div>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
              <input
                type="number"
                value={cmu || ""}
                onChange={(e) => {
                  const val = parseInt(e.target.value) || 0;
                  setCmu(val);
                  if (cmuFromCatalog) setCmuEdited(true);
                  setResult(null);
                }}
                className={`flex h-10 w-full rounded-md border bg-background pl-7 pr-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring tabular-nums ${
                  !selectedModelId
                    ? "border-input opacity-60 cursor-not-allowed"
                    : cmuFromCatalog && !cmuEdited
                    ? "border-primary/30 bg-primary/5"
                    : !cmu
                    ? "border-destructive"
                    : "border-input"
                }`}
                placeholder={selectedModelId ? "Ingresa el CMU manualmente" : "Selecciona modelo primero"}
                disabled={!selectedModelId}
                data-testid="input-cmu"
              />
            </div>
            {!cmuFromCatalog && selectedModelId && !cmu && (
              <p className="text-[10px] text-destructive mt-1">No hay CMU en catálogo para este modelo-año. Ingresa el valor manualmente.</p>
            )}
            {cmuFromCatalog && !cmuEdited && selectedModel && selectedModel.cmuMin && selectedModel.cmuMax && (
              <p className="text-[10px] text-muted-foreground mt-1">
                Rango mercado: {formatMXN(selectedModel.cmuMin)} – {formatMXN(selectedModel.cmuMax)}
                {selectedModel.cmuSampleCount && (
                  <span> · {selectedModel.cmuSampleCount} anuncios</span>
                )}
              </p>
            )}

            {/* Market Prices Button + Results */}
            {selectedModelId && (
              <div className="mt-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-1.5 h-8 text-xs"
                  onClick={handleFetchMarketPrices}
                  disabled={isFetchingPrices}
                  data-testid="button-fetch-market-prices"
                >
                  {isFetchingPrices ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Globe className="w-3.5 h-3.5" />
                  )}
                  {isFetchingPrices ? "Consultando Kavak, Autocosmos, Seminuevos..." : "Consultar precios de mercado"}
                </Button>

                {marketData && marketData.count > 0 && (
                  <div className="mt-2 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-lg p-3" data-testid="market-prices-result">
                    <div className="flex items-center gap-1.5 mb-2">
                      <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
                      <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                        {marketData.count} precios encontrados
                      </span>
                      <span className="text-[10px] text-emerald-600 ml-auto">
                        {marketData.sources.map(s => `${s.name} (${s.count})`).join(" · ")}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-center">
                      <div>
                        <p className="text-[10px] text-muted-foreground">Mínimo</p>
                        <p className="text-xs font-bold text-emerald-700 dark:text-emerald-400 flex items-center justify-center gap-0.5">
                          <ArrowDown className="w-2.5 h-2.5" />
                          {formatMXN(marketData.min!)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground">Mediana</p>
                        <p className="text-xs font-bold text-emerald-800 dark:text-emerald-300">
                          {formatMXN(marketData.median!)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground">Promedio</p>
                        <p className="text-xs font-bold tabular-nums">
                          {formatMXN(marketData.average!)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground">Máximo</p>
                        <p className="text-xs font-bold text-amber-600 flex items-center justify-center gap-0.5">
                          <ArrowUp className="w-2.5 h-2.5" />
                          {formatMXN(marketData.max!)}
                        </p>
                      </div>
                    </div>
                    <p className="text-[9px] text-emerald-600 dark:text-emerald-500 mt-2 text-center">
                      CMU actualizado a mediana de mercado. Puedes editar manualmente.
                    </p>
                  </div>
                )}

                {marketData && marketData.count === 0 && (
                  <p className="text-[10px] text-amber-600 mt-1">
                    No se encontraron precios de mercado para este modelo. {marketData.message}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Insurer Price */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Precio Aseguradora (MXN)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
              <input
                type="number"
                value={insurerPrice || ""}
                onChange={(e) => { setInsurerPrice(parseInt(e.target.value) || 0); setResult(null); }}
                className="flex h-10 w-full rounded-md border border-input bg-background pl-7 pr-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring tabular-nums"
                placeholder="123,000"
                data-testid="input-insurer-price"
              />
            </div>
          </div>

          {/* Repair Estimate with Slider */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Reparación Estimada (MXN)
              </label>
              <span className="text-sm font-semibold tabular-nums" data-testid="text-repair-value">
                {formatMXN(repairEstimate)}
              </span>
            </div>
            <Slider
              value={[repairEstimate]}
              onValueChange={(v) => { setRepairEstimate(v[0]); setResult(null); }}
              min={0}
              max={50000}
              step={1000}
              className="mb-2"
              data-testid="slider-repair"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>$0</span>
              <span>$10k</span>
              <span>$20k</span>
              <span>$30k</span>
              <span>$50k</span>
            </div>
          </div>

          {/* Photo-based Repair Estimation */}
          <PhotoRepairEstimate
            onEstimate={(mid) => {
              setRepairEstimate(mid);
              setResult(null);
            }}
          />

          {/* Quick preview */}
          {selectedModel && insurerPrice > 0 && (
            <div className="flex items-center gap-4 text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2" data-testid="preview-bar">
              <span>Costo total: <strong className="text-foreground">{formatMXN(insurerPrice + repairEstimate)}</strong></span>
              <span>% CMU: <strong className="text-foreground">{cmu > 0 ? formatPct((insurerPrice + repairEstimate) / cmu) : "—"}</strong></span>
              <span>Margen: <strong className="text-foreground">{cmu > 0 ? formatMXN(cmu - insurerPrice - repairEstimate) : "—"}</strong></span>
            </div>
          )}

          {/* Evaluate button */}
          <Button
            size="lg"
            className="w-full gap-2"
            onClick={handleEvaluate}
            disabled={!selectedModel || !insurerPrice || !cmu || isEvaluating}
            data-testid="button-evaluate"
          >
            {isEvaluating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Calculator className="w-4 h-4" />
            )}
            {isEvaluating ? "Calculando..." : "Evaluar Oportunidad"}
          </Button>
        </CardContent>
      </Card>

      {/* Result */}
      {result && (
        <>
          <DecisionCard result={result} />
          <Button
            variant="outline"
            className="w-full gap-2 h-10"
            onClick={() => generateEvaluationPdf(result)}
            data-testid="button-download-evaluation-pdf"
          >
            <ArrowDown className="w-4 h-4" />
            Descargar Evaluación PDF
          </Button>
        </>
      )}

      {/* History */}
      {showHistory && opportunities && opportunities.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
              <History className="w-4 h-4 text-muted-foreground" />
              Historial de Evaluaciones
            </h3>
            <div className="space-y-2">
              {opportunities.slice(0, 10).map((opp: any) => (
                <div key={opp.id} className="flex items-center justify-between text-xs border-b border-border last:border-0 py-2">
                  <div>
                    <span className="font-medium">#{opp.id}</span>
                    <span className="text-muted-foreground ml-2">CMU {formatMXN(opp.cmuUsed)} → Costo {formatMXN(opp.totalCost)}</span>
                  </div>
                  <span className={`font-medium px-2 py-0.5 rounded text-[10px] ${
                    opp.decision === "COMPRAR" && opp.decisionLevel === "optimo"
                      ? "bg-emerald-100 text-emerald-700"
                      : opp.decision === "COMPRAR"
                      ? "bg-blue-100 text-blue-700"
                      : opp.decision === "DUDOSO"
                      ? "bg-amber-100 text-amber-700"
                      : "bg-red-100 text-red-700"
                  }`}>
                    {opp.decision}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Supuestos + Threshold Config */}
      <Card>
        <CardContent className="p-3">
          <p className="text-[10px] text-muted-foreground text-center">
            Supuestos: Plazo 36 meses · Anticipo Capital $50k (mes 2) · Recaudo GNV $4,400/mes · Markup ×1.237 · Aguascalientes
          </p>
          <details className="mt-2">
            <summary className="text-[10px] text-primary cursor-pointer font-medium text-center" data-testid="toggle-thresholds">
              Configurar umbrales de decisión
            </summary>
            <div className="mt-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[9px] text-muted-foreground">Óptimo: Margen mínimo ($)</label>
                  <Input
                    type="number"
                    value={thresholdState.optimoMarginMin}
                    onChange={(e) => handleThresholdChange({ optimoMarginMin: parseInt(e.target.value) || 0 })}
                    className="h-7 text-xs"
                    data-testid="input-threshold-optimo-margin"
                  />
                </div>
                <div>
                  <label className="text-[9px] text-muted-foreground">Óptimo: TIR mínima (%)</label>
                  <Input
                    type="number"
                    step="0.01"
                    value={Math.round(thresholdState.optimoTirMin * 100)}
                    onChange={(e) => handleThresholdChange({ optimoTirMin: (parseInt(e.target.value) || 0) / 100 })}
                    className="h-7 text-xs"
                    data-testid="input-threshold-optimo-tir"
                  />
                </div>
                <div>
                  <label className="text-[9px] text-muted-foreground">Bueno: Margen mínimo ($)</label>
                  <Input
                    type="number"
                    value={thresholdState.buenoMarginMin}
                    onChange={(e) => handleThresholdChange({ buenoMarginMin: parseInt(e.target.value) || 0 })}
                    className="h-7 text-xs"
                    data-testid="input-threshold-bueno-margin"
                  />
                </div>
                <div>
                  <label className="text-[9px] text-muted-foreground">Bueno: TIR mínima (%)</label>
                  <Input
                    type="number"
                    step="0.01"
                    value={Math.round(thresholdState.buenoTirMin * 100)}
                    onChange={(e) => handleThresholdChange({ buenoTirMin: (parseInt(e.target.value) || 0) / 100 })}
                    className="h-7 text-xs"
                    data-testid="input-threshold-bueno-tir"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="text-[10px] h-6 flex-1" onClick={() => { resetThresholds(); setThresholdState(getThresholds()); setResult(null); }}>
                  Restaurar defaults
                </Button>
              </div>
              <p className="text-[9px] text-muted-foreground text-center">
                Margen ≥{formatMXN(thresholdState.optimoMarginMin)} AND TIR ≥{Math.round(thresholdState.optimoTirMin * 100)}% = ÓPTIMO |
                Margen ≥{formatMXN(thresholdState.buenoMarginMin)} AND TIR ≥{Math.round(thresholdState.buenoTirMin * 100)}% = BUENO
              </p>
            </div>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}
