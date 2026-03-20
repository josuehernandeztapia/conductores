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
} from "lucide-react";
import { useState, useMemo, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import type { Origination, VehicleInventory } from "@shared/schema";
import { ORIGINATION_STEPS, DOCUMENT_TYPES } from "@shared/schema";
import {
  subscribe,
  apiListOriginations,
  apiListVehicles,
} from "@/lib/api";
import { updateOrigination } from "@/lib/storage";

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

  const handleAction = (action: "approve" | "reject") => {
    setIsPending(true);
    try {
      updateOrigination(origination.id, {
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

  // Parse all stored JSON fields
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
        {/* Header info */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono font-semibold">{origination.folio}</span>
          <Badge variant="secondary" className={`text-[10px] ${estadoCfg.color}`}>
            {estadoCfg.label}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {origination.tipo === "validacion" ? "Validación" : "Compraventa"}
          </Badge>
          <Badge variant="outline" className="text-[10px]">Perfil {origination.perfilTipo}</Badge>
        </div>

        {/* Step progress */}
        <div className="space-y-1.5">
          <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Progreso</div>
          <div className="flex gap-1">
            {ORIGINATION_STEPS.map((s) => (
              <div
                key={s.step}
                className={`flex-1 h-1.5 rounded-full transition-colors ${
                  s.step < origination.currentStep
                    ? "bg-emerald-500"
                    : s.step === origination.currentStep
                    ? "bg-blue-500"
                    : "bg-muted"
                }`}
                title={`Paso ${s.step}: ${s.name}`}
              />
            ))}
          </div>
          <div className="text-xs text-muted-foreground">
            Paso {origination.currentStep}/7: {stepInfo?.name} — {stepInfo?.description}
          </div>
        </div>

        <Separator />

        {/* Extracted data sections */}
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

        {/* Verification status */}
        <div className="space-y-2">
          <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Verificación</div>
          <div className="flex items-center gap-3 text-xs">
            <div className="flex items-center gap-1.5">
              {origination.otpVerified === 1 ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              ) : (
                <XCircle className="w-3.5 h-3.5 text-red-500" />
              )}
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
              <>
                <Camera className="w-3.5 h-3.5 text-emerald-600" />
                <span className="text-emerald-700 dark:text-emerald-400">Selfie capturada</span>
              </>
            ) : (
              <>
                <Camera className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">Selfie pendiente</span>
              </>
            )}
          </div>
        </div>

        {/* Contract info */}
        {origination.contractType && (
          <>
            <Separator />
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Contrato</div>
              <div className="text-xs space-y-0.5">
                <div>Tipo: <span className="font-medium">{origination.contractType === "convenio_validacion" ? "Convenio de Validación" : "Compraventa a Plazos"}</span></div>
                {origination.contractGeneratedAt && (
                  <div className="text-muted-foreground">Generado: {new Date(origination.contractGeneratedAt).toLocaleString("es-MX")}</div>
                )}
                {origination.contractUrl && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1 text-[10px] h-7 gap-1"
                    onClick={() => {
                      const a = document.createElement("a");
                      a.href = origination.contractUrl!;
                      a.download = `${origination.folio}.pdf`;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                    }}
                    data-testid="button-download-contract"
                  >
                    <FileText className="w-3 h-3" />
                    Descargar PDF
                  </Button>
                )}
              </div>
            </div>
          </>
        )}

        {/* Dates */}
        <Separator />
        <div className="text-[10px] text-muted-foreground space-y-0.5">
          <div>Creado: {new Date(origination.createdAt).toLocaleString("es-MX")}</div>
          <div>Actualizado: {new Date(origination.updatedAt).toLocaleString("es-MX")}</div>
          {origination.rejectionReason && (
            <div className="text-red-600 font-medium mt-1">Motivo rechazo: {origination.rejectionReason}</div>
          )}
        </div>

        {/* Actions */}
        {canActOnFolio && (
          <>
            <Separator />
            <div className="flex gap-2 pb-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 gap-1.5 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                onClick={() => handleAction("reject")}
                disabled={isPending}
                data-testid="button-reject-folio"
              >
                <ThumbsDown className="w-3.5 h-3.5" />
                Rechazar
              </Button>
              <Button
                size="sm"
                className="flex-1 gap-1.5"
                onClick={() => handleAction("approve")}
                disabled={isPending}
                data-testid="button-approve-folio"
              >
                {isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ThumbsUp className="w-3.5 h-3.5" />
                )}
                Aprobar
              </Button>
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  );
}

/** Inline row-level approve/reject buttons */
function InlineActions({ origination }: { origination: Origination }) {
  const { toast } = useToast();
  const [isPending, setIsPending] = useState(false);

  const handleAction = (action: "approve" | "reject") => {
    setIsPending(true);
    try {
      updateOrigination(origination.id, {
        estado: action === "approve" ? "APROBADO" : "RECHAZADO",
        rejectionReason: action === "reject" ? "Rechazado por administrador" : undefined,
      });
      toast({ title: action === "approve" ? "Aprobado" : "Rechazado" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  if (["APROBADO", "RECHAZADO"].includes(origination.estado)) return null;

  return (
    <div className="flex gap-0.5">
      <button
        onClick={(e) => { e.stopPropagation(); handleAction("approve"); }}
        disabled={isPending}
        className="p-1 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/30 transition-colors"
        title="Aprobar"
        data-testid={`button-inline-approve-${origination.id}`}
      >
        {isPending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
        ) : (
          <ThumbsUp className="w-3.5 h-3.5 text-emerald-600" />
        )}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); handleAction("reject"); }}
        disabled={isPending}
        className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
        title="Rechazar"
        data-testid={`button-inline-reject-${origination.id}`}
      >
        <ThumbsDown className="w-3.5 h-3.5 text-red-500" />
      </button>
    </div>
  );
}

export default function PanelPage() {
  const [selectedFolio, setSelectedFolio] = useState<Origination | null>(null);
  const [originations, setOriginations] = useState<Origination[]>([]);
  const [vehicles, setVehicles] = useState<VehicleInventory[]>([]);

  // Load data and subscribe to in-memory store changes
  useEffect(() => {
    apiListOriginations().then(setOriginations).catch(console.error);
    apiListVehicles().then(setVehicles).catch(console.error);

    const unsubscribe = subscribe(() => {
      apiListOriginations().then(setOriginations).catch(console.error);
      apiListVehicles().then(setVehicles).catch(console.error);
    });
    return unsubscribe;
  }, []);

  // Folio KPIs
  const kpis = useMemo(() => {
    return {
      total: originations.length,
      activos: originations.filter((o) => !["APROBADO", "RECHAZADO"].includes(o.estado)).length,
      aprobados: originations.filter((o) => o.estado === "APROBADO").length,
      rechazados: originations.filter((o) => o.estado === "RECHAZADO").length,
    };
  }, [originations]);

  // Vehicle KPIs
  const vehicleKpis = useMemo(() => {
    return {
      total: vehicles.length,
      disponibles: vehicles.filter((v) => v.status === "disponible").length,
      asignados: vehicles.filter((v) => v.status === "asignado").length,
      reparacion: vehicles.filter((v) => v.status === "en_reparacion").length,
    };
  }, [vehicles]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <LayoutDashboard className="w-5 h-5 text-muted-foreground" />
        <div>
          <h1 className="text-sm font-semibold" data-testid="text-panel-title">Panel CMU</h1>
          <p className="text-[10px] text-muted-foreground">Dashboard administrativo — Ángeles Mireles</p>
        </div>
      </div>

      {/* KPI Cards — Row 1: Folios */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <FileText className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-[10px] text-muted-foreground">Folios Totales</span>
            </div>
            <div className="text-xl font-semibold tabular-nums" data-testid="kpi-folios-total">{kpis.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="w-3.5 h-3.5 text-blue-600" />
              <span className="text-[10px] text-muted-foreground">En Proceso</span>
            </div>
            <div className="text-xl font-semibold tabular-nums text-blue-600" data-testid="kpi-folios-activos">{kpis.activos}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              <span className="text-[10px] text-muted-foreground">Aprobados</span>
            </div>
            <div className="text-xl font-semibold tabular-nums text-emerald-600" data-testid="kpi-folios-aprobados">{kpis.aprobados}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <XCircle className="w-3.5 h-3.5 text-red-500" />
              <span className="text-[10px] text-muted-foreground">Rechazados</span>
            </div>
            <div className="text-xl font-semibold tabular-nums text-red-600" data-testid="kpi-folios-rechazados">{kpis.rechazados}</div>
          </CardContent>
        </Card>
      </div>

      {/* KPI Cards — Row 2: Vehicles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <Car className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-[10px] text-muted-foreground">Vehículos Total</span>
            </div>
            <div className="text-xl font-semibold tabular-nums" data-testid="kpi-vehicles-total">{vehicleKpis.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <Warehouse className="w-3.5 h-3.5 text-emerald-600" />
              <span className="text-[10px] text-muted-foreground">Disponibles</span>
            </div>
            <div className="text-xl font-semibold tabular-nums text-emerald-600" data-testid="kpi-vehicles-disponibles">{vehicleKpis.disponibles}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <User className="w-3.5 h-3.5 text-blue-600" />
              <span className="text-[10px] text-muted-foreground">Asignados</span>
            </div>
            <div className="text-xl font-semibold tabular-nums text-blue-600" data-testid="kpi-vehicles-asignados">{vehicleKpis.asignados}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
              <span className="text-[10px] text-muted-foreground">En Reparación</span>
            </div>
            <div className="text-xl font-semibold tabular-nums text-amber-600" data-testid="kpi-vehicles-reparacion">{vehicleKpis.reparacion}</div>
          </CardContent>
        </Card>
      </div>

      {/* Folio table */}
      <div>
        <h2 className="text-sm font-medium mb-3">Folios de Originación</h2>
        {!originations.length ? (
          <Card>
            <CardContent className="p-6 text-center">
              <FileText className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No hay folios de originación aún</p>
              <p className="text-[10px] text-muted-foreground mt-1">Los folios aparecerán aquí cuando la promotora los cree desde Originación</p>
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-xs" data-testid="table-panel-folios">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left py-2.5 px-3 font-medium">Folio</th>
                  <th className="text-center py-2.5 px-2 font-medium">Tipo</th>
                  <th className="text-center py-2.5 px-2 font-medium">Perfil</th>
                  <th className="text-center py-2.5 px-2 font-medium">Estado</th>
                  <th className="text-center py-2.5 px-2 font-medium">Paso</th>
                  <th className="text-right py-2.5 px-2 font-medium">Fecha</th>
                  <th className="text-center py-2.5 px-3 font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {originations.map((orig) => {
                  const estadoCfg = ESTADO_CONFIG[orig.estado] || ESTADO_CONFIG.BORRADOR;
                  return (
                    <tr
                      key={orig.id}
                      className="border-b last:border-0 hover:bg-muted/20 transition-colors cursor-pointer"
                      onClick={() => setSelectedFolio(orig)}
                      data-testid={`row-folio-${orig.id}`}
                    >
                      <td className="py-2.5 px-3 font-mono font-medium">{orig.folio}</td>
                      <td className="text-center py-2.5 px-2">
                        <Badge variant="outline" className="text-[10px]">
                          {orig.tipo === "validacion" ? "VAL" : "CPV"}
                        </Badge>
                      </td>
                      <td className="text-center py-2.5 px-2">{orig.perfilTipo}</td>
                      <td className="text-center py-2.5 px-2">
                        <Badge variant="secondary" className={`text-[10px] ${estadoCfg.color}`}>
                          {estadoCfg.label}
                        </Badge>
                      </td>
                      <td className="text-center py-2.5 px-2 tabular-nums">{orig.currentStep}/7</td>
                      <td className="text-right py-2.5 px-2 text-muted-foreground">
                        {new Date(orig.createdAt).toLocaleDateString("es-MX", { day: "numeric", month: "short" })}
                      </td>
                      <td className="text-center py-2.5 px-3">
                        <div className="flex items-center justify-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => setSelectedFolio(orig)}
                            className="p-1 rounded hover:bg-muted transition-colors"
                            title="Ver detalle"
                            data-testid={`button-view-folio-${orig.id}`}
                          >
                            <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                          </button>
                          <InlineActions origination={orig} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
