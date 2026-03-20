import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Warehouse,
  Plus,
  Car,
  Wrench,
  CheckCircle2,
  XCircle,
  Pencil,
  Loader2,
  Fuel,
} from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import type { VehicleInventory, ModelOption } from "@shared/schema";
import {
  apiListVehicles,
  apiCreateVehicle,
  apiGetModelOptions,
  subscribe,
} from "@/lib/api";
import { updateVehicle } from "@/lib/storage";

function formatMXN(value: number | null | undefined): string {
  if (value == null) return "—";
  return `$${value.toLocaleString("es-MX")}`;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof Car }> = {
  disponible: { label: "Disponible", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400", icon: CheckCircle2 },
  asignado: { label: "Asignado", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400", icon: Car },
  en_reparacion: { label: "En Reparación", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400", icon: Wrench },
  vendido: { label: "Vendido", color: "bg-primary/10 text-primary", icon: CheckCircle2 },
  baja: { label: "Baja", color: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400", icon: XCircle },
};

function VehicleForm({ vehicle, onClose, onSaved }: {
  vehicle?: VehicleInventory;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [catalogModels, setCatalogModels] = useState<ModelOption[]>(() => apiGetModelOptions());
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribe(() => {
      setCatalogModels(apiGetModelOptions());
    });
    return unsubscribe;
  }, []);

  const [form, setForm] = useState({
    marca: vehicle?.marca || "",
    modelo: vehicle?.modelo || "",
    variante: vehicle?.variante || "",
    anio: vehicle?.anio || new Date().getFullYear(),
    color: vehicle?.color || "",
    niv: vehicle?.niv || "",
    placas: vehicle?.placas || "",
    numSerie: vehicle?.numSerie || "",
    numMotor: (vehicle as any)?.numMotor || "",
    cmuValor: vehicle?.cmuValor || 0,
    costoAdquisicion: vehicle?.costoAdquisicion || 0,
    costoReparacion: vehicle?.costoReparacion || 0,
    status: vehicle?.status || "disponible",
    kitGnvInstalado: vehicle?.kitGnvInstalado || 0,
    kitGnvCosto: vehicle?.kitGnvCosto || 0,
    kitGnvMarca: (vehicle as any)?.kitGnvMarca || "",
    kitGnvSerie: (vehicle as any)?.kitGnvSerie || "",
    tanqueTipo: (vehicle as any)?.tanqueTipo || "",
    tanqueMarca: (vehicle as any)?.tanqueMarca || "",
    tanqueSerie: (vehicle as any)?.tanqueSerie || "",
    tanqueCosto: (vehicle as any)?.tanqueCosto || 0,
    notes: vehicle?.notes || "",
  });

  const catalogEntries = catalogModels
    ? Array.from(
        new Map(
          catalogModels.map((m) => [
            `${m.brand}|${m.model}|${m.variant || ""}|${m.year}`,
            m,
          ])
        ).values()
      ).sort((a, b) => `${a.brand} ${a.model}`.localeCompare(`${b.brand} ${b.model}`) || a.year - b.year)
    : [];

  const handleCatalogSelect = (value: string) => {
    const model = catalogEntries.find((m) => String(m.id) === value);
    if (model) {
      setForm((p) => ({
        ...p,
        marca: model.brand,
        modelo: model.model,
        variante: model.variant || "",
        anio: model.year,
        cmuValor: model.cmu,
      }));
    }
  };

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const now = new Date().toISOString();
      const payload = {
        marca: form.marca,
        modelo: form.modelo,
        variante: form.variante || null,
        anio: form.anio,
        color: form.color || null,
        niv: form.niv || null,
        placas: form.placas || null,
        numSerie: form.numSerie || null,
        numMotor: form.numMotor || null,
        cmuValor: form.cmuValor || null,
        costoAdquisicion: form.costoAdquisicion || null,
        costoReparacion: form.costoReparacion || null,
        status: form.status,
        assignedOriginationId: null,
        assignedTaxistaId: null,
        kitGnvInstalado: form.kitGnvInstalado,
        kitGnvCosto: form.kitGnvCosto || null,
        kitGnvMarca: form.kitGnvMarca || null,
        kitGnvSerie: form.kitGnvSerie || null,
        tanqueTipo: form.tanqueTipo || null,
        tanqueMarca: form.tanqueMarca || null,
        tanqueSerie: form.tanqueSerie || null,
        tanqueCosto: form.tanqueCosto || null,
        fotos: null,
        notes: form.notes || null,
        createdAt: now,
        updatedAt: now,
      };

      if (vehicle) {
        updateVehicle(vehicle.id, payload);
        toast({ title: "Vehículo actualizado" });
      } else {
        await apiCreateVehicle(payload);
        toast({ title: "Vehículo agregado" });
      }
      onSaved();
      onClose();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  }, [form, vehicle, toast, onSaved, onClose]);

  const update = (field: string, value: any) => setForm((p) => ({ ...p, [field]: value }));

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Llenar desde catálogo</label>
        <Select onValueChange={handleCatalogSelect}>
          <SelectTrigger data-testid="select-catalog"><SelectValue placeholder="Seleccionar del catálogo..." /></SelectTrigger>
          <SelectContent>
            {catalogEntries.map((m) => (
              <SelectItem key={m.id} value={String(m.id)}>
                {m.brand} {m.displayName} {m.year} — CMU {formatMXN(m.cmu)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Marca</label>
          <Select value={form.marca} onValueChange={(v) => update("marca", v)}>
            <SelectTrigger><SelectValue placeholder="Marca" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="Nissan">Nissan</SelectItem>
              <SelectItem value="Chevrolet">Chevrolet</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Modelo</label>
          <Select value={form.modelo} onValueChange={(v) => update("modelo", v)}>
            <SelectTrigger><SelectValue placeholder="Modelo" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="March">March</SelectItem>
              <SelectItem value="V-Drive">V-Drive</SelectItem>
              <SelectItem value="Aveo">Aveo</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Variante</label>
          <Input value={form.variante} onChange={(e) => update("variante", e.target.value)} placeholder="Sense, Advance..." data-testid="input-variante" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Año</label>
          <Input type="number" value={form.anio} onChange={(e) => update("anio", parseInt(e.target.value) || 0)} data-testid="input-anio" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Color</label>
          <Input value={form.color} onChange={(e) => update("color", e.target.value)} placeholder="Blanco" data-testid="input-color" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">NIV</label>
          <Input value={form.niv} onChange={(e) => update("niv", e.target.value)} placeholder="VIN" data-testid="input-niv" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Placas</label>
          <Input value={form.placas} onChange={(e) => update("placas", e.target.value)} placeholder="AGS-1234" data-testid="input-placas" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Núm. Serie</label>
          <Input value={form.numSerie} onChange={(e) => update("numSerie", e.target.value)} placeholder="NL000001" data-testid="input-num-serie" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Núm. Motor</label>
          <Input value={form.numMotor} onChange={(e) => update("numMotor", e.target.value)} placeholder="HR12DE-001234" data-testid="input-num-motor" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">CMU Valor</label>
          <Input type="number" value={form.cmuValor || ""} onChange={(e) => update("cmuValor", parseInt(e.target.value) || 0)} data-testid="input-cmu-valor" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Costo Adquisición</label>
          <Input type="number" value={form.costoAdquisicion || ""} onChange={(e) => update("costoAdquisicion", parseInt(e.target.value) || 0)} data-testid="input-costo-adq" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Costo Reparación</label>
          <Input type="number" value={form.costoReparacion || ""} onChange={(e) => update("costoReparacion", parseInt(e.target.value) || 0)} data-testid="input-costo-rep" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Status</label>
          <Select value={form.status} onValueChange={(v) => update("status", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="disponible">Disponible</SelectItem>
              <SelectItem value="en_reparacion">En Reparación</SelectItem>
              <SelectItem value="asignado">Asignado</SelectItem>
              <SelectItem value="vendido">Vendido</SelectItem>
              <SelectItem value="baja">Baja</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Kit GNV</label>
          <Select value={String(form.kitGnvInstalado)} onValueChange={(v) => update("kitGnvInstalado", parseInt(v))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="0">No instalado</SelectItem>
              <SelectItem value="1">Instalado</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {form.kitGnvInstalado === 1 && (
        <div className="space-y-3 border-l-2 border-emerald-300 dark:border-emerald-700 pl-3">
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
            <Fuel className="w-3.5 h-3.5" />
            Detalles Kit GNV
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Marca Kit</label>
              <Input value={form.kitGnvMarca} onChange={(e) => update("kitGnvMarca", e.target.value)} placeholder="LOVATO" data-testid="input-kit-gnv-marca" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Serie Kit</label>
              <Input value={form.kitGnvSerie} onChange={(e) => update("kitGnvSerie", e.target.value)} placeholder="LVT-2024-0001" data-testid="input-kit-gnv-serie" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Costo Kit</label>
              <Input type="number" value={form.kitGnvCosto || ""} onChange={(e) => update("kitGnvCosto", parseInt(e.target.value) || 0)} data-testid="input-kit-gnv-costo" />
            </div>
          </div>

          <div className="text-xs font-medium text-muted-foreground mt-2">Tanque GNV</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Tipo Tanque</label>
              <Select value={form.tanqueTipo || ""} onValueChange={(v) => update("tanqueTipo", v)}>
                <SelectTrigger><SelectValue placeholder="Tipo..." /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="nuevo">Nuevo</SelectItem>
                  <SelectItem value="reusado">Reusado</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Costo Tanque</label>
              <Input type="number" value={form.tanqueCosto || ""} onChange={(e) => update("tanqueCosto", parseInt(e.target.value) || 0)} data-testid="input-tanque-costo" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Marca Tanque</label>
              <Input value={form.tanqueMarca} onChange={(e) => update("tanqueMarca", e.target.value)} placeholder="CILBRAS" data-testid="input-tanque-marca" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Serie Tanque</label>
              <Input value={form.tanqueSerie} onChange={(e) => update("tanqueSerie", e.target.value)} placeholder="CIL-60L-0001" data-testid="input-tanque-serie" />
            </div>
          </div>
        </div>
      )}

      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Notas</label>
        <Input value={form.notes} onChange={(e) => update("notes", e.target.value)} placeholder="Notas adicionales..." data-testid="input-notes" />
      </div>

      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={onClose} className="flex-1">Cancelar</Button>
        <Button
          onClick={handleSave}
          disabled={!form.marca || !form.modelo || !form.anio || isSaving}
          className="flex-1 gap-2"
          data-testid="button-save-vehicle"
        >
          {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
          {vehicle ? "Actualizar" : "Agregar"}
        </Button>
      </div>
    </div>
  );
}

export default function InventarioPage() {
  const [statusFilter, setStatusFilter] = useState<string>("todos");
  const [showForm, setShowForm] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<VehicleInventory | undefined>();
  const [vehicles, setVehicles] = useState<VehicleInventory[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  // Load vehicles and subscribe to in-memory store changes
  useEffect(() => {
    apiListVehicles().then(setVehicles).catch(console.error);
    const unsubscribe = subscribe(() => {
      apiListVehicles().then(setVehicles).catch(console.error);
    });
    return unsubscribe;
  }, [refreshKey]);

  const filtered = vehicles?.filter((v) => statusFilter === "todos" || v.status === statusFilter) || [];

  const statusCounts = vehicles?.reduce<Record<string, number>>((acc, v) => {
    acc[v.status] = (acc[v.status] || 0) + 1;
    return acc;
  }, {}) || {};

  const handleEdit = useCallback((v: VehicleInventory) => {
    setEditingVehicle(v);
    setShowForm(true);
  }, []);

  const handleAdd = useCallback(() => {
    setEditingVehicle(undefined);
    setShowForm(true);
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Warehouse className="w-5 h-5 text-muted-foreground" />
          <div>
            <h1 className="text-sm font-semibold">Inventario de Vehículos</h1>
            <p className="text-[10px] text-muted-foreground">{vehicles?.length || 0} vehículos en flota</p>
          </div>
        </div>
        <Button size="sm" className="gap-1.5" onClick={handleAdd} data-testid="button-add-vehicle">
          <Plus className="w-3.5 h-3.5" />
          Agregar
        </Button>
      </div>

      {/* Status counters */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setStatusFilter("todos")}
          className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${statusFilter === "todos" ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
          data-testid="filter-todos"
        >
          Todos ({vehicles?.length || 0})
        </button>
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${statusFilter === key ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
            data-testid={`filter-${key}`}
          >
            {cfg.label} ({statusCounts[key] || 0})
          </button>
        ))}
      </div>

      {/* Vehicle list */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <Car className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No hay vehículos{statusFilter !== "todos" ? ` con status "${STATUS_CONFIG[statusFilter]?.label}"` : ""}</p>
            <Button size="sm" variant="outline" className="mt-3 gap-1.5" onClick={handleAdd}>
              <Plus className="w-3.5 h-3.5" />
              Agregar vehículo
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((v) => {
            const statusCfg = STATUS_CONFIG[v.status] || STATUS_CONFIG.disponible;
            const vAny = v as any;
            return (
              <Card key={v.id} className="hover:bg-muted/30 transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold">
                          {v.marca} {v.modelo} {v.variante || ""} {v.anio}
                        </span>
                        <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${statusCfg.color}`}>
                          {statusCfg.label}
                        </Badge>
                        {v.kitGnvInstalado === 1 && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">GNV</Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {v.placas && <span>Placas: {v.placas}</span>}
                        {v.color && <span>Color: {v.color}</span>}
                        {v.niv && <span className="font-mono text-[10px]">NIV: {v.niv}</span>}
                        {vAny.numMotor && <span className="font-mono text-[10px]">Motor: {vAny.numMotor}</span>}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-xs">
                        <span className="text-muted-foreground">CMU: <strong className="text-foreground">{formatMXN(v.cmuValor)}</strong></span>
                        <span className="text-muted-foreground">Adquisición: <strong className="text-foreground">{formatMXN(v.costoAdquisicion)}</strong></span>
                        <span className="text-muted-foreground">Reparación: <strong className="text-foreground">{formatMXN(v.costoReparacion)}</strong></span>
                      </div>
                      {v.kitGnvInstalado === 1 && (vAny.kitGnvMarca || vAny.tanqueTipo) && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-[10px] text-muted-foreground">
                          {vAny.kitGnvMarca && <span>Kit: {vAny.kitGnvMarca}</span>}
                          {vAny.tanqueTipo && <span>Tanque: {vAny.tanqueTipo} {vAny.tanqueMarca || ""}</span>}
                        </div>
                      )}
                      {v.notes && (
                        <p className="text-[10px] text-muted-foreground mt-1.5">{v.notes}</p>
                      )}
                    </div>
                    <button
                      onClick={() => handleEdit(v)}
                      className="p-2 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                      data-testid={`button-edit-vehicle-${v.id}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {editingVehicle ? "Editar Vehículo" : "Agregar Vehículo"}
            </DialogTitle>
          </DialogHeader>
          <VehicleForm
            vehicle={editingVehicle}
            onClose={() => setShowForm(false)}
            onSaved={() => setRefreshKey((k) => k + 1)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
