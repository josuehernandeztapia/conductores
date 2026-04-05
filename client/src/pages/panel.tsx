import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  LayoutDashboard,
  FileText,
  Car,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Eye,
  ThumbsUp,
  ThumbsDown,
  Warehouse,
  User,
  Phone,
  Shield,
  CreditCard,
  FileCheck,
  Camera,
  Hash,
  ChevronDown,
  ChevronUp,
  Loader2,
  Plus,
  ClipboardList,
  ArrowRight,
  TrendingUp,
  FileWarning,
} from "lucide-react";
import { useState, useMemo, useEffect } from "react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import type { Origination, VehicleInventory } from "@shared/schema";
import { ORIGINATION_STEPS, DOCUMENT_TYPES } from "@shared/schema";
import {
  subscribe,
  apiListOriginations,
  apiListVehicles,
  apiListEvaluations,
  apiUpdateOrigination,
} from "@/lib/api";

const ESTADO_CONFIG: Record<string, { label: string; color: string; icon: typeof Clock }> = {
  BORRADOR: { label: "Borrador", color: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300", icon: Clock },
  CAPTURANDO: { label: "Capturando", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400", icon: Clock },
  VALIDADO: { label: "Validado", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400", icon: CheckCircle2 },
  GENERADO: { label: "Generado", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400", icon: FileText },
  FIRMADO: { label: "Firmado", color: "bg-primary/10 text-primary", icon: CheckCircle2 },
  APROBADO: { label: "Aprobado", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400", icon: CheckCircle2 },
  INCOMPLETO: { label: "Incompleto", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400", icon: AlertTriangle },
  RECHAZADO: { label: "Rechazado", color: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400", icon: XCircle },
};

/** Section with collapsible card for extracted data */
function DataSection({ title, icon: Icon, data, emptyMsg }: {
  title: string;
  icon: typeof User;
  data: Record<string, any> | null;
  emptyMsg?: string;
}) {
  const [open, setOpen] = useState(true);

  if (!data || Object.keys(data).length === 0) {
    return (
      <div className="flex items-center gap-2 py-1.5 text-[10px] text-muted-foreground">
        <Icon className="w-3 h-3 shrink-0" />
        <span>{title}: {emptyMsg || "Sin datos"}</span>
      </div>
    );
  }

  return (
    <div className="border rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left text-xs font-medium bg-muted/30 hover:bg-muted/50 transition-colors"
        data-testid={`toggle-section-${title.toLowerCase().replace(/\s/g, "-")}`}
      >
        <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="flex-1">{title}</span>
        <Badge variant="secondary" className="text-[9px] mr-1">{Object.keys(data).length} campos</Badge>
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-3 py-2 text-[10px]">
          {Object.entries(data).map(([k, v]) => (
            <div key={k} className="flex gap-1 min-w-0">
              <span className="text-muted-foreground capitalize shrink-0">{k.replace(/_/g, " ")}:</span>
              <span className="font-medium truncate">{String(v || "—")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Full detail view for a single origination folio */
function FolioDetail({ origination, onClose }: { origination: Origination; onClose: () => void }) {
  const { toast } = useToast();
  const [isPending, setIsPending] = useState(false);

  const handleAction = async (action: "approve" | "reject") => {
    setIsPending(true);
    try {
      await apiUpdateOrigination(origination.id, {
        estado: action === "approve" ? "APROBADO" : "RECHAZADO",
        rejectionReason: action === "reject" ? "Rechazado por administrador" : undefined,
      });
      toast({ title: action === "approve" ? "Folio aprobado" : "Folio rechazado" });
      onClose();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  const stepInfo = ORIGINATION_STEPS.find((s) => s.step === origination.currentStep);
  const estadoCfg = ESTADO_CONFIG[origination.estado] || ESTADO_CONFIG.BORRADOR;

  const p = (field: string | null): Record<string, any> | null => {
    if (!field) return null;
    try { return JSON.parse(field); } catch { return null; }
  };

  const parsedData = {
    ine: p(origination.datosIne),
    csf: p(origination.datosCsf),
    comprobante: p(origination.datosComprobante),
    concesion: p(origination.datosConcesion),
    estadoCuenta: p(origination.datosEstadoCuenta),
    historial: p(origination.datosHistorial),
    factura: p(origination.datosFactura),
    membresia: p(origination.datosMembresia),
  };

  const canActOnFolio = !["APROBADO", "RECHAZADO"].includes(origination.estado);

  return (
    <ScrollArea className="max-h-[75vh]">
      <div className="space-y-4 pr-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono font-semibold">{origination.folio}</span>
          <Badge variant="secondary" className={`text-[10px] ${estadoCfg.color}`}>{estadoCfg.label}</Badge>
          <Badge variant="outline" className="text-[10px]">{origination.tipo === "validacion" ? "Validación" : "Compraventa"}</Badge>
          <Badge variant="outline" className="text-[10px]">Perfil {origination.perfilTipo}</Badge>
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Progreso</div>
          <div className="flex gap-1">
            {ORIGINATION_STEPS.map((s) => (
              <div key={s.step} className={`flex-1 h-1.5 rounded-full transition-colors ${
                s.step < origination.currentStep ? "bg-emerald-500" : s.step === origination.currentStep ? "bg-blue-500" : "bg-muted"
              }`} title={`Paso ${s.step}: ${s.name}`} />
            ))}
          </div>
          <div className="text-xs text-muted-foreground">
            Paso {origination.currentStep}/7: {stepInfo?.name} — {stepInfo?.description}
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Datos extraídos (OCR)</div>
          <DataSection title="INE" icon={User} data={parsedData.ine} emptyMsg="No capturada" />
          <DataSection title="Situación Fiscal" icon={FileCheck} data={parsedData.csf} emptyMsg="No capturada" />
          <DataSection title="Comprobante Domicilio" icon={FileText} data={parsedData.comprobante} emptyMsg="No capturado" />
          <DataSection title="Concesión" icon={Car} data={parsedData.concesion} emptyMsg="No capturada" />
          <DataSection title="Estado de Cuenta" icon={CreditCard} data={parsedData.estadoCuenta} emptyMsg="No capturado" />
          <DataSection title="Historial / Tickets" icon={Hash} data={parsedData.historial} emptyMsg="No capturado" />
          <DataSection title="Factura Vehículo" icon={Car} data={parsedData.factura} emptyMsg="No capturada" />
          <DataSection title="Membresía" icon={Shield} data={parsedData.membresia} emptyMsg="No capturada" />
        </div>

        <Separator />

        <div className="space-y-2">
          <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Verificación</div>
          <div className="flex items-center gap-3 text-xs">
            <div className="flex items-center gap-1.5">
              {origination.otpVerified === 1 ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <XCircle className="w-3.5 h-3.5 text-red-500" />}
              <span className={origination.otpVerified === 1 ? "text-emerald-700 dark:text-emerald-400" : "text-red-600"}>
                {origination.otpVerified === 1 ? "OTP verificado" : "OTP pendiente"}
              </span>
            </div>
            {origination.otpPhone && (
              <div className="flex items-center gap-1 text-muted-foreground">
                <Phone className="w-3 h-3" />
                <span>{origination.otpPhone}</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            {origination.selfieUrl ? (
              <><Camera className="w-3.5 h-3.5 text-emerald-600" /><span className="text-emerald-700 dark:text-emerald-400">Selfie capturada</span></>
            ) : (
              <><Camera className="w-3.5 h-3.5 text-muted-foreground" /><span className="text-muted-foreground">Selfie pendiente</span></>
            )}
          </div>
        </div>

        {origination.contractType && (
          <>
            <Separator />
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Contrato</div>
              <div className="text-xs space-y-0.5">
                <div>Tipo: <span className="font-medium">{origination.contractType === "convenio_validacion" ? "Convenio de Validación" : "Compraventa a Plazos"}</span></div>
                {origination.contractGeneratedAt && (
                  <div className="text-muted-foreground">Generado: {new Date(origination.contractGeneratedAt).toLocaleString("es-MX", { timeZone: "America/Mexico_City" })}</div>
                )}
                {origination.contractUrl && (
                  <Button variant="outline" size="sm" className="mt-1 text-[10px] h-7 gap-1"
                    onClick={() => { const a = document.createElement("a"); a.href = origination.contractUrl!; a.download = `${origination.folio}.pdf`; document.body.appendChild(a); a.click(); document.body.removeChild(a); }}
                    data-testid="button-download-contract"
                  ><FileText className="w-3 h-3" />Descargar PDF</Button>
                )}
              </div>
            </div>
          </>
        )}

        <Separator />
        <div className="text-[10px] text-muted-foreground space-y-0.5">
          <div>Creado: {new Date(origination.createdAt).toLocaleString("es-MX", { timeZone: "America/Mexico_City" })}</div>
          <div>Actualizado: {new Date(origination.updatedAt).toLocaleString("es-MX", { timeZone: "America/Mexico_City" })}</div>
          {origination.rejectionReason && (
            <div className="text-red-600 font-medium mt-1">Motivo rechazo: {origination.rejectionReason}</div>
          )}
        </div>

        {canActOnFolio && (
          <>
            <Separator />
            <div className="flex gap-2 pb-2">
              <Button variant="outline" size="sm" className="flex-1 gap-1.5 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                onClick={() => handleAction("reject")} disabled={isPending} data-testid="button-reject-folio">
                <ThumbsDown className="w-3.5 h-3.5" /> Rechazar
              </Button>
              <Button size="sm" className="flex-1 gap-1.5" onClick={() => handleAction("approve")} disabled={isPending} data-testid="button-approve-folio">
                {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ThumbsUp className="w-3.5 h-3.5" />} Aprobar
              </Button>
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  );
}

export default function PanelPage() {
  const [selectedFolio, setSelectedFolio] = useState<Origination | null>(null);
  const [originations, setOriginations] = useState<Origination[]>([]);
  const [vehicles, setVehicles] = useState<VehicleInventory[]>([]);
  const [evaluations, setEvaluations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const loadAll = async () => {
      try {
        const [origs, vehs, evals] = await Promise.all([
          apiListOriginations().catch(() => [] as Origination[]),
          apiListVehicles().catch(() => [] as VehicleInventory[]),
          apiListEvaluations().catch(() => [] as any[]),
        ]);
        if (!mounted) return;
        setOriginations(origs);
        setVehicles(vehs);
        setEvaluations(evals);
        // If everything empty, retry (cold start on Fly)
        if (origs.length === 0 && vehs.length === 0 && attempts < 5) {
          attempts++;
          retryTimer = setTimeout(loadAll, 1000 + attempts * 1000);
          return;
        }
      } catch {
        if (mounted && attempts < 5) {
          attempts++;
          retryTimer = setTimeout(loadAll, 1000 + attempts * 1000);
          return;
        }
      }
      if (mounted) setLoading(false);
    };

    loadAll();

    const unsubscribe = subscribe(() => {
      if (!mounted) return;
      apiListOriginations().catch(() => []).then(d => mounted && setOriginations(d));
      apiListVehicles().catch(() => []).then(d => mounted && setVehicles(d));
    });

    return () => {
      mounted = false;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, []);

  // KPIs
  const kpis = useMemo(() => {
    const activos = originations.filter((o) => !["APROBADO", "RECHAZADO"].includes(o.estado));
    const docsPendientes = originations.filter((o) => o.currentStep < 7 && !["APROBADO", "RECHAZADO"].includes(o.estado));
    const today = new Date().toISOString().slice(0, 10);
    const evalsHoy = evaluations.filter((e) => String(e.created_at || e.createdAt || "").slice(0, 10) === today);

    return {
      foliosActivos: activos.length,
      docsPendientes: docsPendientes.length,
      vehiculosDisponibles: vehicles.filter((v) => v.status === "disponible").length,
      evaluacionesHoy: evalsHoy.length,
      totalVehiculos: vehicles.length,
      totalOriginations: originations.length,
      aprobados: originations.filter((o) => o.estado === "APROBADO").length,
      rechazados: originations.filter((o) => o.estado === "RECHAZADO").length,
      vehiculosAsignados: vehicles.filter((v) => v.status === "asignado").length,
      vehiculosReparacion: vehicles.filter((v) => v.status === "en_reparacion").length,
    };
  }, [originations, vehicles, evaluations]);

  const recentFolios = useMemo(() => {
    return [...originations].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, 5);
  }, [originations]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <LayoutDashboard className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-semibold" data-testid="text-panel-title">Panel CMU</h1>
            <p className="text-xs text-muted-foreground">Dashboard administrativo — Conductores del Mundo</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href="/motor">
            <Button variant="outline" size="sm" className="gap-1.5 text-xs h-8" data-testid="btn-quick-eval">
              <TrendingUp className="w-3.5 h-3.5" />
              Nueva Evaluación
            </Button>
          </Link>
          <Link href="/originacion">
            <Button size="sm" className="gap-1.5 text-xs h-8" data-testid="btn-quick-folio">
              <Plus className="w-3.5 h-3.5" />
              Nuevo Folio
            </Button>
          </Link>
        </div>
      </div>

      {/* KPI Cards — Main Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="border-l-4 border-l-blue-500">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] text-muted-foreground font-medium">Folios Activos</p>
                <p className="text-2xl font-bold tabular-nums mt-1" data-testid="kpi-folios-activos">{kpis.foliosActivos}</p>
              </div>
              <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <ClipboardList className="w-5 h-5 text-blue-500" />
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">{kpis.totalOriginations} totales</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] text-muted-foreground font-medium">Docs Pendientes</p>
                <p className="text-2xl font-bold tabular-nums mt-1 text-amber-600" data-testid="kpi-docs-pendientes">{kpis.docsPendientes}</p>
              </div>
              <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <FileWarning className="w-5 h-5 text-amber-500" />
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">Folios sin completar paso 7</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-emerald-500">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] text-muted-foreground font-medium">Vehículos Disponibles</p>
                <p className="text-2xl font-bold tabular-nums mt-1 text-emerald-600" data-testid="kpi-vehicles-disponibles">{kpis.vehiculosDisponibles}</p>
              </div>
              <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <Car className="w-5 h-5 text-emerald-500" />
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">{kpis.totalVehiculos} en flota</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-purple-500">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] text-muted-foreground font-medium">Evaluaciones Hoy</p>
                <p className="text-2xl font-bold tabular-nums mt-1 text-purple-600" data-testid="kpi-evals-hoy">{kpis.evaluacionesHoy}</p>
              </div>
              <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center">
                <TrendingUp className="w-5 h-5 text-purple-500" />
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">{evaluations.length} total histórico</p>
          </CardContent>
        </Card>
      </div>

      {/* Secondary KPI row */}
      <div className="grid grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
            <div>
              <p className="text-lg font-semibold tabular-nums">{kpis.aprobados}</p>
              <p className="text-[10px] text-muted-foreground">Aprobados</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <XCircle className="w-4 h-4 text-red-500 shrink-0" />
            <div>
              <p className="text-lg font-semibold tabular-nums">{kpis.rechazados}</p>
              <p className="text-[10px] text-muted-foreground">Rechazados</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <User className="w-4 h-4 text-blue-500 shrink-0" />
            <div>
              <p className="text-lg font-semibold tabular-nums">{kpis.vehiculosAsignados}</p>
              <p className="text-[10px] text-muted-foreground">V. Asignados</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
            <div>
              <p className="text-lg font-semibold tabular-nums">{kpis.vehiculosReparacion}</p>
              <p className="text-[10px] text-muted-foreground">En Reparación</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Origination Funnel */}
      {originations.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h3 className="text-xs font-semibold mb-3 flex items-center gap-2">
              <TrendingUp className="w-3.5 h-3.5 text-primary" />
              Embudo de Originación
            </h3>
            <div className="space-y-2">
              {[
                { label: "Documentos", filter: (o: Origination) => o.currentStep >= 2, color: "bg-blue-500" },
                { label: "Verificado", filter: (o: Origination) => o.currentStep >= 3, color: "bg-cyan-500" },
                { label: "Revisado", filter: (o: Origination) => o.currentStep >= 4, color: "bg-amber-500" },
                { label: "Vehículo", filter: (o: Origination) => o.currentStep >= 5, color: "bg-orange-500" },
                { label: "Contrato", filter: (o: Origination) => o.currentStep >= 6, color: "bg-purple-500" },
                { label: "Firmado", filter: (o: Origination) => o.estado === "FIRMADO" || o.estado === "APROBADO", color: "bg-emerald-500" },
              ].map((stage) => {
                const count = originations.filter(stage.filter).length;
                const pct = originations.length > 0 ? (count / originations.length) * 100 : 0;
                return (
                  <div key={stage.label} className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground w-16 text-right">{stage.label}</span>
                    <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${stage.color} transition-all duration-500`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-medium tabular-nums w-8">{count}</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Folios */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Últimos Folios</h2>
          <Link href="/originacion">
            <Button variant="ghost" size="sm" className="text-xs gap-1 h-7 text-primary" data-testid="link-ver-todos">
              Ver todos <ArrowRight className="w-3 h-3" />
            </Button>
          </Link>
        </div>
        {!recentFolios.length ? (
          <Card>
            <CardContent className="p-8 text-center">
              <FileText className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-50" />
              <p className="text-sm text-muted-foreground">No hay folios de originación aún</p>
              <p className="text-[10px] text-muted-foreground mt-1 mb-4">Los folios aparecerán aquí cuando la promotora los cree desde Originación</p>
              <Link href="/originacion">
                <Button size="sm" className="gap-1.5">
                  <Plus className="w-3.5 h-3.5" /> Crear primer folio
                </Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {recentFolios.map((orig) => {
              const estadoCfg = ESTADO_CONFIG[orig.estado] || ESTADO_CONFIG.BORRADOR;
              const StepIcon = estadoCfg.icon;
              return (
                <Card
                  key={orig.id}
                  className="hover:bg-muted/30 transition-colors cursor-pointer group"
                  onClick={() => setSelectedFolio(orig)}
                  data-testid={`row-folio-${orig.id}`}
                >
                  <CardContent className="p-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                        orig.estado === "APROBADO" ? "bg-emerald-500/10" :
                        orig.estado === "RECHAZADO" ? "bg-red-500/10" :
                        "bg-blue-500/10"
                      }`}>
                        <StepIcon className={`w-4 h-4 ${
                          orig.estado === "APROBADO" ? "text-emerald-500" :
                          orig.estado === "RECHAZADO" ? "text-red-500" :
                          "text-blue-500"
                        }`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-semibold">{orig.folio}</span>
                          <Badge variant="secondary" className={`text-[9px] ${estadoCfg.color}`}>{estadoCfg.label}</Badge>
                          <Badge variant="outline" className="text-[9px]">{orig.tipo === "validacion" ? "VAL" : "CPV"}</Badge>
                        </div>
                        <div className="flex items-center gap-3 mt-0.5">
                          <span className="text-[10px] text-muted-foreground">Perfil {orig.perfilTipo}</span>
                          <span className="text-[10px] text-muted-foreground">Paso {orig.currentStep}/7</span>
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(orig.createdAt).toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                      </div>
                      {/* Progress mini-bar */}
                      <div className="hidden sm:flex items-center gap-0.5">
                        {[1,2,3,4,5,6,7].map(s => (
                          <div key={s} className={`w-1.5 h-4 rounded-full ${
                            s < orig.currentStep ? "bg-emerald-500" : s === orig.currentStep ? "bg-blue-500" : "bg-muted"
                          }`} />
                        ))}
                      </div>
                      <ArrowRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Detail Dialog */}
      <Dialog open={!!selectedFolio} onOpenChange={(v) => { if (!v) setSelectedFolio(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm">Detalle del Folio</DialogTitle>
          </DialogHeader>
          {selectedFolio && (
            <FolioDetail origination={selectedFolio} onClose={() => setSelectedFolio(null)} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
