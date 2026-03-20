import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
} from "lucide-react";
import { useState, useCallback, useEffect } from "react";
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

const ESTADO_CONFIG: Record<string, { label: string; color: string }> = {
  BORRADOR: { label: "Borrador", color: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
  CAPTURANDO: { label: "Capturando", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400" },
  VALIDADO: { label: "Validado", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400" },
  GENERADO: { label: "Generado", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400" },
  FIRMADO: { label: "Firmado", color: "bg-primary/10 text-primary" },
  APROBADO: { label: "Aprobado", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400" },
  INCOMPLETO: { label: "Incompleto", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400" },
  RECHAZADO: { label: "Rechazado", color: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400" },
};

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
      // Create taxista record
      const now = new Date().toISOString();
      const taxista = createTaxista({
        folio: null,
        nombre,
        apellidoPaterno,
        apellidoMaterno: null,
        curp: null,
        rfc: null,
        telefono,
        email: null,
        direccion: null,
        ciudad: "Aguascalientes",
        estado: "Aguascalientes",
        codigoPostal: null,
        perfilTipo,
        gnvHistorialLeq: null,
        gnvMesesHistorial: null,
        ticketsGasolinaMensual: null,
        clabe: null,
        banco: null,
        createdAt: now,
      });

      // Generate folio
      const prefix = tipo === "validacion" ? "CMU-VAL" : "CMU-CPV";
      const d = new Date();
      const dateStr = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
      const seq = getNextFolioSequence(prefix, dateStr);
      const folio = `${prefix}-${dateStr}-${String(seq).padStart(3, "0")}`;

      // Create origination via API
      const orig = await apiCreateOrigination({
        folio,
        tipo,
        perfilTipo,
        taxistaId: taxista.id,
        promoterId: 1,
        otpPhone: telefono,
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
          {/* Tipo */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Tipo de Trámite</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setTipo("validacion")}
                className={`p-3 rounded-lg border text-left transition-colors ${
                  tipo === "validacion" ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"
                }`}
                data-testid="button-tipo-validacion"
              >
                <div className="text-xs font-medium">Validación</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">Lista de espera (sin vehículo asignado)</div>
              </button>
              <button
                onClick={() => setTipo("compraventa")}
                className={`p-3 rounded-lg border text-left transition-colors ${
                  tipo === "compraventa" ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"
                }`}
                data-testid="button-tipo-compraventa"
              >
                <div className="text-xs font-medium">Compraventa</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">Vehículo disponible en inventario</div>
              </button>
            </div>
          </div>

          {/* Perfil */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Perfil de Taxista</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setPerfilTipo("A")}
                className={`p-3 rounded-lg border text-left transition-colors ${
                  perfilTipo === "A" ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"
                }`}
                data-testid="button-perfil-a"
              >
                <div className="text-xs font-medium">Perfil A — GNV</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">Historial ≥400 LEQ/mes</div>
              </button>
              <button
                onClick={() => setPerfilTipo("B")}
                className={`p-3 rounded-lg border text-left transition-colors ${
                  perfilTipo === "B" ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"
                }`}
                data-testid="button-perfil-b"
              >
                <div className="text-xs font-medium">Perfil B — Gasolina</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">Tickets ≥$6,000/mes</div>
              </button>
            </div>
          </div>

          {/* Quick taxista info */}
          <div className="space-y-3 pt-1">
            <label className="text-xs font-medium text-muted-foreground block">Datos del Taxista</label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Input
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                  placeholder="Nombre(s)"
                  data-testid="input-nombre"
                />
              </div>
              <div>
                <Input
                  value={apellidoPaterno}
                  onChange={(e) => setApellidoPaterno(e.target.value)}
                  placeholder="Apellido paterno"
                  data-testid="input-apellido"
                />
              </div>
            </div>
            <Input
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              placeholder="Teléfono (10 dígitos)"
              type="tel"
              data-testid="input-telefono"
            />
          </div>

          <Button
            className="w-full gap-2"
            onClick={handleCreate}
            disabled={!nombre || !apellidoPaterno || !telefono || isCreating}
            data-testid="button-create-folio"
          >
            {isCreating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <FileText className="w-4 h-4" />
            )}
            Crear Folio
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function OriginacionPage() {
  const [, setLocation] = useLocation();
  const [showCreate, setShowCreate] = useState(false);
  const [estadoFilter, setEstadoFilter] = useState<string>("todos");
  const [originations, setOriginations] = useState<Origination[]>([]);

  // Load originations and subscribe to in-memory store changes
  useEffect(() => {
    apiListOriginations().then(setOriginations).catch(console.error);
    const unsubscribe = subscribe(() => {
      apiListOriginations().then(setOriginations).catch(console.error);
    });
    return unsubscribe;
  }, []);

  const filtered = originations.filter((o) => estadoFilter === "todos" || o.estado === estadoFilter);

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
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

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setEstadoFilter("todos")}
          className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${estadoFilter === "todos" ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
        >
          Todos
        </button>
        {["BORRADOR", "CAPTURANDO", "VALIDADO", "GENERADO", "FIRMADO", "APROBADO"].map((estado) => (
          <button
            key={estado}
            onClick={() => setEstadoFilter(estado)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${estadoFilter === estado ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            {ESTADO_CONFIG[estado]?.label || estado}
          </button>
        ))}
      </div>

      {/* Origination list */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <FileText className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No hay folios de originación</p>
            <Button variant="outline" size="sm" className="mt-3 gap-1.5" onClick={() => setShowCreate(true)}>
              <Plus className="w-3.5 h-3.5" />
              Crear primer folio
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((orig) => {
            const estadoCfg = ESTADO_CONFIG[orig.estado] || ESTADO_CONFIG.BORRADOR;
            const stepInfo = ORIGINATION_STEPS.find((s) => s.step === orig.currentStep);
            return (
              <Card
                key={orig.id}
                className="cursor-pointer hover:bg-muted/30 transition-colors"
                onClick={() => setLocation(`/originacion/${orig.id}`)}
                data-testid={`card-folio-${orig.id}`}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-mono font-medium">{orig.folio}</span>
                        <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${estadoCfg.color}`}>
                          {estadoCfg.label}
                        </Badge>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          Perfil {orig.perfilTipo}
                        </Badge>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          {orig.tipo === "validacion" ? "Validación" : "Compraventa"}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {stepInfo && (
                          <span>
                            Paso {orig.currentStep}/7: {stepInfo.name}
                          </span>
                        )}
                        <span>
                          {new Date(orig.createdAt).toLocaleDateString("es-MX", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
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
