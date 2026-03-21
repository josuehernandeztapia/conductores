import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  FileText,
  Plus,
  ArrowRight,
  Loader2,
  Search,
  User,
  Clock,
  CheckCircle2,
  Filter,
  TrendingUp,
  FileCheck2,
  ShieldCheck,
  BarChart3,
} from "lucide-react";
import { useState, useCallback, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import type { Origination } from "@shared/schema";
import { ORIGINATION_STEPS } from "@shared/schema";
import {
  subscribe,
  apiListOriginations,
  apiCreateOrigination,
  createTaxista,
  getNextFolioSequence,
} from "@/lib/api";

const ESTADO_CONFIG: Record<string, { label: string; color: string; icon: typeof FileText }> = {
  BORRADOR: { label: "Borrador", color: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300", icon: FileText },
  CAPTURANDO: { label: "Capturando", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400", icon: FileText },
  VALIDADO: { label: "Validado", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400", icon: FileCheck2 },
  GENERADO: { label: "Generado", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400", icon: FileText },
  FIRMADO: { label: "Firmado", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400", icon: ShieldCheck },
  APROBADO: { label: "Aprobado", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400", icon: CheckCircle2 },
  INCOMPLETO: { label: "Incompleto", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400", icon: Clock },
  RECHAZADO: { label: "Rechazado", color: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400", icon: FileText },
};

function getOperadorName(orig: Origination): string {
  if (orig.datosIne) {
    try {
      const d = JSON.parse(orig.datosIne);
      const parts = [d.nombre, d.apellido_paterno || d.apellidos, d.apellido_materno].filter(Boolean);
      if (parts.length > 0) return parts.join(" ");
    } catch {}
  }
  return "";
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

function CreateFolioDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [tipo, setTipo] = useState<string>("validacion");
  const [perfilTipo, setPerfilTipo] = useState<string>("A");
  const [nombre, setNombre] = useState("");
  const [apellidoPaterno, setApellidoPaterno] = useState("");
  const [telefono, setTelefono] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!nombre || !apellidoPaterno || !telefono) return;
    setIsCreating(true);
    try {
      const now = new Date().toISOString();
      const taxista = createTaxista({
        folio: null, nombre, apellidoPaterno, apellidoMaterno: null,
        curp: null, rfc: null, telefono, email: null, direccion: null,
        ciudad: "Aguascalientes", estado: "Aguascalientes", codigoPostal: null,
        perfilTipo, gnvHistorialLeq: null, gnvMesesHistorial: null,
        ticketsGasolinaMensual: null, clabe: null, banco: null, createdAt: now,
      });

      const prefix = tipo === "validacion" ? "CMU-VAL" : "CMU-CPV";
      const d = new Date();
      const dateStr = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
      const seq = getNextFolioSequence(prefix, dateStr);
      const folio = `${prefix}-${dateStr}-${String(seq).padStart(3, "0")}`;

      const orig = await apiCreateOrigination({
        folio, tipo, perfilTipo, taxistaId: taxista.id, promoterId: 1, otpPhone: telefono,
      });

      toast({ title: "Folio creado", description: orig.folio });
      onClose();
      setLocation(`/originacion/${orig.id}`);
    } catch (err: any) {
      toast({ title: "Error", description: err.message || "No se pudo crear el folio", variant: "destructive" });
    } finally {
      setIsCreating(false);
    }
  }, [nombre, apellidoPaterno, telefono, tipo, perfilTipo, toast, onClose, setLocation]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Nuevo Folio de Originación</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Tipo de Trámite</label>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setTipo("validacion")} className={`p-3 rounded-lg border text-left transition-colors ${tipo === "validacion" ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`} data-testid="button-tipo-validacion">
                <div className="text-xs font-medium">Validación</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">Lista de espera (sin vehículo asignado)</div>
              </button>
              <button onClick={() => setTipo("compraventa")} className={`p-3 rounded-lg border text-left transition-colors ${tipo === "compraventa" ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`} data-testid="button-tipo-compraventa">
                <div className="text-xs font-medium">Compraventa</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">Vehículo disponible en inventario</div>
              </button>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Perfil de Taxista</label>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setPerfilTipo("A")} className={`p-3 rounded-lg border text-left transition-colors ${perfilTipo === "A" ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`} data-testid="button-perfil-a">
                <div className="text-xs font-medium">Perfil A — GNV</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">Historial ≥400 LEQ/mes</div>
              </button>
              <button onClick={() => setPerfilTipo("B")} className={`p-3 rounded-lg border text-left transition-colors ${perfilTipo === "B" ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`} data-testid="button-perfil-b">
                <div className="text-xs font-medium">Perfil B — Gasolina</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">Tickets ≥$6,000/mes</div>
              </button>
            </div>
          </div>
          <div className="space-y-3 pt-1">
            <label className="text-xs font-medium text-muted-foreground block">Datos del Taxista</label>
            <div className="grid grid-cols-2 gap-2">
              <Input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre(s)" data-testid="input-nombre" />
              <Input value={apellidoPaterno} onChange={(e) => setApellidoPaterno(e.target.value)} placeholder="Apellido paterno" data-testid="input-apellido" />
            </div>
            <Input value={telefono} onChange={(e) => setTelefono(e.target.value)} placeholder="Teléfono (10 dígitos)" type="tel" data-testid="input-telefono" />
          </div>
          <Button className="w-full gap-2" onClick={handleCreate} disabled={!nombre || !apellidoPaterno || !telefono || isCreating} data-testid="button-create-folio">
            {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            Crear Folio
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ===== KPI Summary Cards =====
function KpiSummary({ originations }: { originations: Origination[] }) {
  const total = originations.length;
  const enProceso = originations.filter(o => ["BORRADOR", "CAPTURANDO", "VALIDADO", "GENERADO"].includes(o.estado)).length;
  const firmados = originations.filter(o => o.estado === "FIRMADO" || o.estado === "APROBADO").length;
  const hoy = originations.filter(o => {
    const d = new Date(o.createdAt);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;

  if (total === 0) return null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-testid="kpi-summary">
      <Card>
        <CardContent className="p-3 text-center">
          <p className="text-lg font-bold" data-testid="kpi-total">{total}</p>
          <p className="text-[10px] text-muted-foreground">Total Folios</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-3 text-center">
          <p className="text-lg font-bold text-blue-600" data-testid="kpi-en-proceso">{enProceso}</p>
          <p className="text-[10px] text-muted-foreground">En Proceso</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-3 text-center">
          <p className="text-lg font-bold text-emerald-600" data-testid="kpi-firmados">{firmados}</p>
          <p className="text-[10px] text-muted-foreground">Firmados</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-3 text-center">
          <p className="text-lg font-bold text-primary" data-testid="kpi-hoy">{hoy}</p>
          <p className="text-[10px] text-muted-foreground">Hoy</p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function OriginacionPage() {
  const [, setLocation] = useLocation();
  const [showCreate, setShowCreate] = useState(false);
  const [estadoFilter, setEstadoFilter] = useState<string>("todos");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"recent" | "estado" | "step">("recent");
  const [originations, setOriginations] = useState<Origination[]>([]);

  useEffect(() => {
    apiListOriginations().then(setOriginations).catch(console.error);
    const unsubscribe = subscribe(() => {
      apiListOriginations().then(setOriginations).catch(console.error);
    });
    return unsubscribe;
  }, []);

  const filtered = useMemo(() => {
    let list = originations.filter((o) => estadoFilter === "todos" || o.estado === estadoFilter);

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((o) => {
        const name = getOperadorName(o).toLowerCase();
        return o.folio.toLowerCase().includes(q) || name.includes(q) || o.otpPhone?.includes(q);
      });
    }

    // Sort
    if (sortBy === "estado") {
      const order = ["FIRMADO", "APROBADO", "GENERADO", "VALIDADO", "CAPTURANDO", "BORRADOR", "INCOMPLETO", "RECHAZADO"];
      list.sort((a, b) => order.indexOf(a.estado) - order.indexOf(b.estado));
    } else if (sortBy === "step") {
      list.sort((a, b) => b.currentStep - a.currentStep);
    } else {
      list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    return list;
  }, [originations, estadoFilter, searchQuery, sortBy]);

  const estadoCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    originations.forEach(o => { counts[o.estado] = (counts[o.estado] || 0) + 1; });
    return counts;
  }, [originations]);

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-muted-foreground" />
          <div>
            <h1 className="text-sm font-semibold">Originación</h1>
            <p className="text-[10px] text-muted-foreground">{originations.length} folios</p>
          </div>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setShowCreate(true)} data-testid="button-new-folio">
          <Plus className="w-3.5 h-3.5" />
          Nuevo Folio
        </Button>
      </div>

      {/* KPI Summary */}
      <KpiSummary originations={originations} />

      {/* Search + Sort */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar por folio, nombre o teléfono..."
            className="pl-8 h-8 text-xs"
            data-testid="input-search"
          />
        </div>
        <div className="flex gap-1">
          {(["recent", "estado", "step"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              className={`text-[10px] px-2 py-1 rounded border transition-colors ${sortBy === s ? "bg-primary/10 text-primary border-primary/30" : "border-border text-muted-foreground hover:text-foreground"}`}
              data-testid={`sort-${s}`}
            >
              {s === "recent" ? "Recientes" : s === "estado" ? "Estado" : "Avance"}
            </button>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => setEstadoFilter("todos")}
          className={`text-[10px] px-2.5 py-1 rounded-full border transition-colors ${estadoFilter === "todos" ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
          data-testid="filter-todos"
        >
          Todos ({originations.length})
        </button>
        {["BORRADOR", "CAPTURANDO", "VALIDADO", "GENERADO", "FIRMADO", "APROBADO"].map((estado) => {
          const count = estadoCounts[estado] || 0;
          if (count === 0 && estadoFilter !== estado) return null;
          return (
            <button
              key={estado}
              onClick={() => setEstadoFilter(estado)}
              className={`text-[10px] px-2.5 py-1 rounded-full border transition-colors ${estadoFilter === estado ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
              data-testid={`filter-${estado.toLowerCase()}`}
            >
              {ESTADO_CONFIG[estado]?.label || estado} ({count})
            </button>
          );
        })}
      </div>

      {/* Origination list */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            {searchQuery ? (
              <>
                <Search className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-40" />
                <p className="text-sm text-muted-foreground">Sin resultados para "{searchQuery}"</p>
                <Button variant="outline" size="sm" className="mt-3 gap-1.5" onClick={() => setSearchQuery("")}>
                  Limpiar búsqueda
                </Button>
              </>
            ) : (
              <>
                <FileText className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-40" />
                <p className="text-sm text-muted-foreground">No hay folios de originación</p>
                <Button variant="outline" size="sm" className="mt-3 gap-1.5" onClick={() => setShowCreate(true)}>
                  <Plus className="w-3.5 h-3.5" />
                  Crear primer folio
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((orig) => {
            const estadoCfg = ESTADO_CONFIG[orig.estado] || ESTADO_CONFIG.BORRADOR;
            const stepInfo = ORIGINATION_STEPS.find((s) => s.step === orig.currentStep);
            const progress = ((orig.currentStep - 1) / 6) * 100;
            const operadorName = getOperadorName(orig);
            const isSigned = orig.estado === "FIRMADO" || orig.estado === "APROBADO";

            return (
              <Card
                key={orig.id}
                className={`cursor-pointer hover:bg-muted/30 transition-colors ${isSigned ? "border-emerald-200 dark:border-emerald-800/50" : ""}`}
                onClick={() => setLocation(`/originacion/${orig.id}`)}
                data-testid={`card-folio-${orig.id}`}
              >
                <CardContent className="p-3">
                  <div className="flex items-start gap-3">
                    {/* Left: progress circle */}
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold ${
                      isSigned
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-400"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      {isSigned ? (
                        <CheckCircle2 className="w-5 h-5" />
                      ) : (
                        <span>{orig.currentStep}/7</span>
                      )}
                    </div>

                    {/* Center: info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs font-mono font-medium">{orig.folio}</span>
                        <Badge variant="secondary" className={`text-[9px] px-1.5 py-0 h-4 ${estadoCfg.color}`}>
                          {estadoCfg.label}
                        </Badge>
                      </div>

                      {/* Operator name + meta */}
                      <div className="flex items-center gap-2 mb-1.5">
                        {operadorName && (
                          <span className="text-xs text-foreground font-medium flex items-center gap-1">
                            <User className="w-3 h-3 text-muted-foreground" />
                            {operadorName}
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                          <Clock className="w-2.5 h-2.5" />
                          {timeAgo(orig.updatedAt || orig.createdAt)}
                        </span>
                        <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5">
                          {orig.perfilTipo}
                        </Badge>
                        <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5">
                          {orig.tipo === "validacion" ? "Val" : "CPV"}
                        </Badge>
                      </div>

                      {/* Progress bar */}
                      {!isSigned && (
                        <div className="flex items-center gap-2">
                          <Progress value={progress} className="h-1 flex-1" />
                          <span className="text-[9px] text-muted-foreground tabular-nums w-8 text-right">
                            {Math.round(progress)}%
                          </span>
                        </div>
                      )}
                      {!isSigned && stepInfo && (
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {stepInfo.name}: {stepInfo.description}
                        </p>
                      )}
                    </div>

                    {/* Right: arrow */}
                    <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-1" />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <CreateFolioDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  );
}
