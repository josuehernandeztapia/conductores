/**
 * Panel de Evaluaciones — Vista Josué
 * 
 * Lista de evaluaciones pendientes con semáforo + detalle completo.
 * Aprobar / Rechazar con motivo.
 * Ángeles NO tiene acceso a esta vista.
 */

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowLeft,
  Loader2,
  ChevronRight,
  Mic,
  Calculator,
  Flag,
  Clock,
  FileText,
  RefreshCw,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API_BASE = "";

interface Evaluacion {
  id: number;
  folio_id: string;
  decision: "GO" | "REVIEW" | "NO-GO";
  score_coherencia: number;
  ingreso_estimado: number;
  ingreso_dia: number;
  ratio_ingreso: number;
  km_dia_estimados: number;
  ingreso_real_mensual: number;
  gastos_totales_mes: number;
  flujo_libre_mes: number;
  ratio_cuota: number;
  cuota_cmu_mensual: number;
  banderas: any[];
  resumen: string;
  horas_dia: number;
  dias_semana: number;
  servicios_dia: number;
  cobro_promedio_servicio: number;
  tiene_chofer: boolean;
  cuenta_chofer: number;
  num_taxis: number;
  gasto_combustible_dia: number;
  mantenimiento_mes: number;
  otros_gastos_vehiculo: number;
  otros_creditos_mes: number;
  voice_responses: any[];
  total_muletillas: number;
  total_evasion: number;
  total_negacion_tajante: number;
  total_honestidad: number;
  avg_disfluency_rate: number;
  avg_honesty_score: number;
  voice_flags: string[];
  override_decision: string | null;
  override_motivo: string | null;
  resultado_pago: string | null;
  created_at: string;
}

function decisionColor(d: string) {
  switch (d) {
    case "GO": return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400";
    case "REVIEW": return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400";
    case "NO-GO": return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400";
    default: return "bg-gray-100 text-gray-700";
  }
}

function decisionIcon(d: string) {
  switch (d) {
    case "GO": return <CheckCircle2 className="w-4 h-4" />;
    case "REVIEW": return <AlertTriangle className="w-4 h-4" />;
    case "NO-GO": return <XCircle className="w-4 h-4" />;
    default: return null;
  }
}

// ===== DETAIL VIEW =====

function EvaluacionDetail({
  evaluacion,
  onBack,
  onRefresh,
}: {
  evaluacion: Evaluacion;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const e = evaluacion;
  const [overrideDecision, setOverrideDecision] = useState<string>("");
  const [overrideMotivo, setOverrideMotivo] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  const handleOverride = async (decision: "GO" | "NO-GO") => {
    setIsSubmitting(true);
    try {
      const resp = await fetch(`${API_BASE}/api/evaluacion/${e.folio_id}/override`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, motivo: overrideMotivo }),
      });
      const data = await resp.json();
      if (data.success) {
        toast({ title: decision === "GO" ? "Aprobado" : "Rechazado", description: `Folio ${e.folio_id}` });
        onRefresh();
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  const fmtMoney = (n: number) => `$${Math.round(n).toLocaleString("es-MX")}`;
  const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

  return (
    <div className="space-y-4 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} data-testid="button-back-list">
          <ArrowLeft className="w-4 h-4 mr-1" />
          Volver
        </Button>
        <div className="flex-1" />
        <Badge className={`text-sm px-3 py-1 ${decisionColor(e.override_decision || e.decision)}`}>
          {decisionIcon(e.override_decision || e.decision)}
          <span className="ml-1.5">{e.override_decision || e.decision}</span>
        </Badge>
      </div>

      {/* Score summary */}
      <Card>
        <div className="px-5 py-3 bg-muted/30 border-b flex items-center gap-2">
          <Calculator className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Coherencia Financiera</h3>
          <span className="ml-auto text-2xl font-bold">{e.score_coherencia}</span>
          <span className="text-xs text-muted-foreground">/ 100</span>
        </div>
        <CardContent className="p-5">
          <p className="text-sm mb-4">{e.resumen}</p>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="space-y-0.5">
              <span className="text-muted-foreground">Ingreso declarado/día</span>
              <p className="font-bold">{fmtMoney(e.ingreso_dia)}</p>
            </div>
            <div className="space-y-0.5">
              <span className="text-muted-foreground">Ingreso estimado (serv × cobro)</span>
              <p className="font-bold">{fmtMoney(e.ingreso_estimado)}</p>
            </div>
            <div className="space-y-0.5">
              <span className="text-muted-foreground">Ratio ingreso</span>
              <p className={`font-bold ${(e.ratio_ingreso ?? 0) < 0.8 || (e.ratio_ingreso ?? 0) > 1.3 ? "text-red-600" : "text-emerald-600"}`}>
                {(e.ratio_ingreso ?? 0).toFixed(2)}
              </p>
            </div>
            <div className="space-y-0.5">
              <span className="text-muted-foreground">Km/día estimados</span>
              <p className="font-bold">{(e.km_dia_estimados ?? 0).toFixed(0)} km</p>
            </div>
            <div className="space-y-0.5">
              <span className="text-muted-foreground">Ingreso real/mes</span>
              <p className="font-bold">{fmtMoney(e.ingreso_real_mensual)}</p>
            </div>
            <div className="space-y-0.5">
              <span className="text-muted-foreground">Gastos totales/mes</span>
              <p className="font-bold">{fmtMoney(e.gastos_totales_mes)}</p>
            </div>
            <div className="space-y-0.5 col-span-2 pt-2 border-t">
              <span className="text-muted-foreground">Flujo libre mensual</span>
              <p className={`text-lg font-bold ${e.flujo_libre_mes > 0 ? "text-emerald-600" : "text-red-600"}`}>
                {fmtMoney(e.flujo_libre_mes)}
              </p>
            </div>
            <div className="space-y-0.5">
              <span className="text-muted-foreground">Cuota CMU</span>
              <p className="font-bold">{fmtMoney(e.cuota_cmu_mensual)}</p>
            </div>
            <div className="space-y-0.5">
              <span className="text-muted-foreground">Ratio cuota / flujo libre</span>
              <p className={`font-bold ${e.ratio_cuota > 0.35 ? "text-red-600" : e.ratio_cuota > 0.25 ? "text-amber-600" : "text-emerald-600"}`}>
                {fmtPct(e.ratio_cuota)}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Raw data */}
      <Card>
        <div className="px-5 py-3 bg-muted/30 border-b flex items-center gap-2">
          <FileText className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Datos Capturados</h3>
        </div>
        <CardContent className="p-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
            <div><span className="text-muted-foreground">Horas/día</span><p className="font-bold">{e.horas_dia}</p></div>
            <div><span className="text-muted-foreground">Días/semana</span><p className="font-bold">{e.dias_semana}</p></div>
            <div><span className="text-muted-foreground">Servicios/día</span><p className="font-bold">{e.servicios_dia}</p></div>
            <div><span className="text-muted-foreground">Cobro/servicio</span><p className="font-bold">{fmtMoney(e.cobro_promedio_servicio)}</p></div>
            <div><span className="text-muted-foreground">Combustible/día</span><p className="font-bold">{fmtMoney(e.gasto_combustible_dia)}</p></div>
            <div><span className="text-muted-foreground">Mantenimiento/mes</span><p className="font-bold">{fmtMoney(e.mantenimiento_mes)}</p></div>
            <div><span className="text-muted-foreground">Otros gastos vehículo</span><p className="font-bold">{fmtMoney(e.otros_gastos_vehiculo)}</p></div>
            <div><span className="text-muted-foreground">Otros créditos/mes</span><p className="font-bold">{fmtMoney(e.otros_creditos_mes)}</p></div>
            <div><span className="text-muted-foreground">Tiene chofer</span><p className="font-bold">{e.tiene_chofer ? `Sí · ${fmtMoney(e.cuenta_chofer)}/día` : "No"}</p></div>
            <div><span className="text-muted-foreground">Taxis</span><p className="font-bold">{e.num_taxis}</p></div>
          </div>
        </CardContent>
      </Card>

      {/* Banderas */}
      {e.banderas && e.banderas.length > 0 && (
        <Card>
          <div className="px-5 py-3 bg-muted/30 border-b flex items-center gap-2">
            <Flag className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Banderas ({e.banderas.length})</h3>
          </div>
          <CardContent className="p-5 space-y-2">
            {e.banderas.map((b: any, i: number) => (
              <div key={i} className={`flex items-start gap-2 p-2 rounded text-xs ${
                b.severidad === "CRITICAL" ? "bg-red-50 dark:bg-red-900/20" :
                b.severidad === "WARNING" ? "bg-amber-50 dark:bg-amber-900/20" :
                "bg-blue-50 dark:bg-blue-900/20"
              }`}>
                {b.severidad === "CRITICAL" ? <XCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" /> :
                 b.severidad === "WARNING" ? <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" /> :
                 <CheckCircle2 className="w-3.5 h-3.5 text-blue-500 mt-0.5 flex-shrink-0" />}
                <div>
                  <p className="font-semibold">{b.tipo}</p>
                  <p className="text-muted-foreground">{b.descripcion}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Voice analysis (passive) */}
      <Card>
        <div className="px-5 py-3 bg-muted/30 border-b flex items-center gap-2">
          <Mic className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Análisis de Voz (pasivo)</h3>
          <Badge variant="outline" className="text-[9px] ml-auto">No afecta decisión</Badge>
        </div>
        <CardContent className="p-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div><span className="text-muted-foreground">Muletillas</span><p className="font-bold">{e.total_muletillas}</p></div>
            <div><span className="text-muted-foreground">Evasión</span><p className="font-bold">{e.total_evasion}</p></div>
            <div><span className="text-muted-foreground">Negación tajante</span><p className={`font-bold ${e.total_negacion_tajante >= 3 ? "text-red-600" : ""}`}>{e.total_negacion_tajante}</p></div>
            <div><span className="text-muted-foreground">Honestidad</span><p className="font-bold">{e.total_honestidad}</p></div>
            <div><span className="text-muted-foreground">Disfluencia promedio</span><p className="font-bold">{e.avg_disfluency_rate.toFixed(1)}%</p></div>
            <div><span className="text-muted-foreground">Score honestidad</span><p className="font-bold">{(e.avg_honesty_score * 100).toFixed(0)}%</p></div>
          </div>

          {e.voice_flags && e.voice_flags.length > 0 && (
            <div className="mt-3 pt-3 border-t">
              <p className="text-[10px] text-muted-foreground mb-1">Flags léxicos:</p>
              <div className="flex flex-wrap gap-1">
                {e.voice_flags.map((f: string, i: number) => (
                  <Badge key={i} variant="outline" className="text-[9px]">{f}</Badge>
                ))}
              </div>
            </div>
          )}

          {/* Transcripts */}
          {e.voice_responses && e.voice_responses.length > 0 && (
            <div className="mt-3 pt-3 border-t space-y-2">
              <p className="text-[10px] text-muted-foreground font-medium">Transcripciones:</p>
              {e.voice_responses.map((vr: any, i: number) => (
                vr.features?.transcript ? (
                  <div key={i} className="text-xs bg-muted/50 p-2 rounded">
                    <span className="font-mono text-[10px] text-muted-foreground">{vr.pregunta_id}</span>
                    <p className="mt-0.5 italic">{`"${vr.features.transcript}"`}</p>
                  </div>
                ) : null
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Override actions */}
      {!e.override_decision && (
        <Card className="border-primary/30">
          <div className="px-5 py-3 bg-primary/5 border-b">
            <h3 className="text-sm font-semibold">Decisión Final</h3>
          </div>
          <CardContent className="p-5 space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Motivo (opcional)</label>
              <Input
                placeholder="Razón de la decisión..."
                value={overrideMotivo}
                onChange={(e) => setOverrideMotivo(e.target.value)}
                data-testid="input-override-motivo"
              />
            </div>
            <div className="flex gap-3">
              <Button
                onClick={() => handleOverride("GO")}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                disabled={isSubmitting}
                data-testid="button-approve"
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-1" />}
                Aprobar
              </Button>
              <Button
                onClick={() => handleOverride("NO-GO")}
                variant="destructive"
                className="flex-1"
                disabled={isSubmitting}
                data-testid="button-reject"
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <XCircle className="w-4 h-4 mr-1" />}
                Rechazar
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Already decided */}
      {e.override_decision && (
        <Card className={`border ${e.override_decision === "GO" ? "border-emerald-300" : "border-red-300"}`}>
          <CardContent className="p-5 text-center space-y-1">
            {e.override_decision === "GO" ? (
              <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto" />
            ) : (
              <XCircle className="w-8 h-8 text-red-500 mx-auto" />
            )}
            <p className="text-sm font-semibold">
              {e.override_decision === "GO" ? "Aprobado" : "Rechazado"}
            </p>
            {e.override_motivo && (
              <p className="text-xs text-muted-foreground">{e.override_motivo}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ===== MAIN LIST VIEW =====

export default function EvaluacionesPage() {
  const [evaluaciones, setEvaluaciones] = useState<Evaluacion[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Evaluacion | null>(null);
  const { toast } = useToast();

  const fetchEvaluaciones = async () => {
    setLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/api/evaluacion/lista`);
      const data = await resp.json();
      if (data.success) {
        setEvaluaciones(data.evaluaciones);
      }
    } catch (err) {
      console.error("Failed to fetch evaluaciones:", err);
      toast({ title: "Error", description: "No se pudieron cargar las evaluaciones", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvaluaciones();
  }, []);

  const handleRefresh = () => {
    setSelected(null);
    fetchEvaluaciones();
  };

  if (selected) {
    return (
      <div className="p-4 sm:p-6">
        <EvaluacionDetail
          evaluacion={selected}
          onBack={() => setSelected(null)}
          onRefresh={handleRefresh}
        />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Evaluaciones</h1>
        <Button variant="ghost" size="sm" onClick={fetchEvaluaciones} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          Actualizar
        </Button>
      </div>

      {loading ? (
        <div className="text-center py-12">
          <Loader2 className="w-8 h-8 animate-spin mx-auto text-muted-foreground" />
        </div>
      ) : evaluaciones.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No hay evaluaciones aún.</p>
            <p className="text-xs mt-1">Aparecerán aquí cuando Ángeles complete una entrevista.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {evaluaciones.map((e) => {
            const finalDecision = e.override_decision || e.decision;
            return (
              <Card
                key={e.id}
                className="cursor-pointer hover:border-primary/40 transition-colors"
                onClick={() => setSelected(e)}
                data-testid={`card-eval-${e.folio_id}`}
              >
                <CardContent className="p-4 flex items-center gap-3">
                  <Badge className={`text-xs px-2 py-0.5 ${decisionColor(finalDecision)}`}>
                    {finalDecision}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium font-mono truncate">{e.folio_id}</p>
                    <p className="text-[10px] text-muted-foreground">
                      Score {e.score_coherencia} · Flujo ${Math.round(e.flujo_libre_mes).toLocaleString()} · Cuota {(e.ratio_cuota * 100).toFixed(0)}%
                      {e.banderas?.length > 0 && ` · ${e.banderas.length} bandera(s)`}
                    </p>
                  </div>
                  {e.override_decision ? (
                    <Badge variant="outline" className="text-[9px]">Decidido</Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px] border-amber-300 text-amber-600">Pendiente</Badge>
                  )}
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
