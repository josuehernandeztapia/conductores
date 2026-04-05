import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
  FileText,
  Calculator,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Search,
} from "lucide-react";
import { useState, useCallback, useEffect, useMemo } from "react";
import { useToast } from "@/hooks/use-toast";
import type { VehicleInventory, ModelOption, EvaluationResult, AmortizationRow } from "@shared/schema";
import {
  apiListVehicles,
  apiCreateVehicle,
  apiGetModelOptions,
  subscribe,
} from "@/lib/api";
import { updateVehicle } from "@/lib/storage";
import { apiUpdateVehicle } from "@/lib/api";
import { evaluateOpportunity } from "@/lib/evaluation-engine";
import { STANDARD } from "@/lib/cmu-standard";
import { jsPDF } from "jspdf";

function formatMXN(value: number | null | undefined): string {
  if (value == null) return "—";
  return `$${value.toLocaleString("es-MX")}`;
}

function formatPctDec(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof Car }> = {
  disponible: { label: "Disponible", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400", icon: CheckCircle2 },
  asignado: { label: "Asignado", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400", icon: Car },
  en_reparacion: { label: "En Reparación", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400", icon: Wrench },
  vendido: { label: "Vendido", color: "bg-primary/10 text-primary", icon: CheckCircle2 },
  baja: { label: "Baja", color: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400", icon: XCircle },
};

// ===== Corrida PDF (for the taxista — no internal metrics) =====
function generateCorridaPdf(v: VehicleInventory, evalResult: EvaluationResult) {
  const doc = new jsPDF({ format: "letter", unit: "mm" });
  const W = 215.9, ML = 18, MR = 18, CW = W - ML - MR;
  let y = 20;
  const fmtM = (n: number) => `$${Math.round(n).toLocaleString("es-MX")}`;
  const gnvRev = evalResult.amortizacionConAnticipo[0]?.gnvRevenue || 4400;

  // ===== HEADER =====
  doc.setFont("helvetica", "bold").setFontSize(13);
  doc.text("Plan de Pagos", ML, y);
  doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(120, 120, 120);
  doc.text("Conductores del Mundo, S.A.P.I. de C.V.", ML + CW, y, { align: "right" });
  doc.setTextColor(0, 0, 0);
  y += 2;
  doc.setDrawColor(0, 180, 170);
  doc.setLineWidth(0.6);
  doc.line(ML, y, ML + CW, y);
  y += 7;

  // ===== VEHICLE =====
  doc.setFont("helvetica", "bold").setFontSize(11);
  doc.text(`${v.marca} ${v.modelo} ${v.variante || ""} ${v.anio}`.trim(), ML, y);
  y += 5;
  if (v.placas || v.niv || v.color) {
    doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(100, 100, 100);
    const parts = [
      v.placas ? `Placas: ${v.placas}` : "",
      v.color ? `Color: ${v.color}` : "",
      v.niv ? `NIV: ${v.niv}` : "",
    ].filter(Boolean);
    doc.text(parts.join("  |  "), ML, y);
    doc.setTextColor(0, 0, 0);
    y += 5;
  }
  y += 4;

  // ===== RESUMEN (client perspective) =====
  const schedule = evalResult.amortizacionConAnticipo;
  const totalCuotas = schedule.reduce((s, r) => s + r.cuota, 0);
  const cuotaM3 = schedule.length >= 3 ? schedule[2].cuota : 0;
  const cuotaLast = schedule[schedule.length - 1]?.cuota || 0;
  const depositoM3 = Math.max(0, cuotaM3 - gnvRev);
  const depositoLast = Math.max(0, cuotaLast - gnvRev);

  doc.setFont("helvetica", "bold").setFontSize(9);
  doc.text("Resumen de tu plan", ML, y);
  y += 6;

  const summaryRows = [
    ["Valor del vehiculo", fmtM(evalResult.precioContado)],
    ["Plazo", "36 meses (cuota decreciente)"],
    ["Anticipo a capital (mes 2)", fmtM(50000)],
    ["Tu consumo GNV cubre", fmtM(gnvRev) + "/mes (automatico)"],
    ["Tu deposito desde mes 3", fmtM(depositoM3) + "/mes"],
    ["Tu deposito mes 36 (ultimo)", depositoLast <= 0 ? "$0 (GNV cubre todo)" : fmtM(depositoLast) + "/mes"],
    ["Total cuotas (36 meses)", fmtM(totalCuotas)],
  ];

  doc.setFontSize(8);
  for (let i = 0; i < summaryRows.length; i++) {
    if (i % 2 === 0) {
      doc.setFillColor(245, 248, 250);
      doc.rect(ML, y - 3, CW, 5.5, "F");
    }
    doc.setFont("helvetica", "normal");
    doc.text(summaryRows[i][0], ML + 2, y);
    doc.setFont("helvetica", "bold");
    doc.text(summaryRows[i][1], ML + CW - 2, y, { align: "right" });
    y += 5.5;
  }
  y += 4;

  // ===== HOW IT WORKS (explainer box) =====
  doc.setFillColor(240, 253, 250);
  doc.roundedRect(ML, y - 2, CW, 16, 2, 2, "F");
  doc.setFont("helvetica", "bold").setFontSize(8).setTextColor(0, 130, 120);
  doc.text("Como funciona tu pago mensual", ML + 4, y + 2);
  doc.setFont("helvetica", "normal").setFontSize(7).setTextColor(60, 60, 60);
  doc.text("Tu consumo de GNV (" + fmtM(gnvRev) + "/mes) se descuenta automaticamente de cada cuota.", ML + 4, y + 7);
  doc.text("Solo depositas la diferencia via transferencia bancaria o pago en OXXO/Conekta.", ML + 4, y + 11);
  doc.text("Las cuotas bajan cada mes porque el interes se calcula sobre el saldo pendiente.", ML + 4, y + 15);
  doc.setTextColor(0, 0, 0);
  y += 20;

  // ===== TABLE: Plan de Pagos =====
  doc.setFont("helvetica", "bold").setFontSize(9);
  doc.text("Detalle mensual", ML, y);
  y += 5;

  // Table header
  const colW = [14, 28, 28, 34, 28, 48];
  const hdrs = ["Mes", "Cuota", "Recaudo GNV", "Tu deposito", "Fondo Gtia.", ""];
  doc.setFont("helvetica", "bold").setFontSize(6.5);
  doc.setFillColor(30, 41, 59);
  doc.rect(ML, y - 3, CW, 5, "F");
  doc.setTextColor(255, 255, 255);
  let cx = ML;
  hdrs.forEach((h, i) => {
    doc.text(h, cx + 1.5, y);
    cx += colW[i];
  });
  doc.setTextColor(0, 0, 0);
  y += 4;

  // Table rows
  doc.setFont("helvetica", "normal").setFontSize(6.5);
  for (const row of schedule) {
    const deposito = row.depositoTransferencia;
    const isAnticipo = row.month === 2;
    const gnvCovers = deposito <= 0;

    if (row.month % 2 === 0 && !isAnticipo) {
      doc.setFillColor(248, 250, 252);
      doc.rect(ML, y - 2.5, CW, 3.5, "F");
    }
    if (isAnticipo) {
      doc.setFillColor(255, 243, 224);
      doc.rect(ML, y - 2.5, CW, 3.5, "F");
    }

    cx = ML;
    const obs = isAnticipo ? "+ Anticipo $50,000" : gnvCovers ? "GNV cubre todo" : "";
    const vals = [
      String(row.month),
      fmtM(row.cuota),
      fmtM(row.gnvRevenue),
      gnvCovers ? "$0" : fmtM(deposito),
      fmtM(row.fondoGarantia),
      obs,
    ];

    vals.forEach((val, i) => {
      if (i === 3) {
        doc.setFont("helvetica", "bold");
        if (gnvCovers) doc.setTextColor(0, 150, 100);
      } else if (i === 5 && val) {
        doc.setFont("helvetica", "bold");
        if (isAnticipo) doc.setTextColor(200, 100, 0);
        else if (gnvCovers) doc.setTextColor(0, 150, 100);
      } else {
        doc.setFont("helvetica", "normal");
      }
      doc.text(val, cx + 1.5, y);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(0, 0, 0);
      cx += colW[i];
    });
    y += 3.2;
    if (y > 262) { doc.addPage(); y = 18; }
  }
  y += 4;

  // ===== NOTES =====
  if (y > 250) { doc.addPage(); y = 18; }
  doc.setFont("helvetica", "normal").setFontSize(6.5).setTextColor(100, 100, 100);
  doc.text("Notas:", ML, y);
  y += 3.5;
  doc.text("- Cuota decreciente: el capital es fijo, el interes baja cada mes sobre el saldo pendiente.", ML + 2, y); y += 3;
  doc.text("- Recaudo GNV: basado en consumo estimado de 400 LEQ/mes x $11/LEQ. El recaudo real varia segun tu consumo.", ML + 2, y); y += 3;
  doc.text("- Anticipo a capital (mes 2): pago unico de $50,000 que reduce el saldo y baja las cuotas restantes.", ML + 2, y); y += 3;
  doc.text("- Fondo de Garantia: $8,000 inicial + $334/mes, tope $20,000. Se devuelve al liquidar el credito.", ML + 2, y); y += 3;
  doc.text("- Deposito: via transferencia SPEI (CLABE 152680120000787681, Bancrea) o pago en OXXO/tienda via liga Conekta.", ML + 2, y);
  doc.setTextColor(0, 0, 0);

  // ===== FOOTER =====
  const pageCount = doc.getNumberOfPages();
  const now = new Date().toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "long", year: "numeric" });
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal").setFontSize(6).setTextColor(150, 150, 150);
    doc.text(
      `Conductores del Mundo, S.A.P.I. de C.V. | RFC: CMU201119DD6 | ${v.marca} ${v.modelo} ${v.anio} | ${now} | Pag. ${i}/${pageCount}`,
      W / 2, 275, { align: "center" }
    );
    doc.setTextColor(0, 0, 0);
  }

  const slug = `${v.marca}-${v.modelo}-${v.anio}`.replace(/\s+/g, "-").toLowerCase();
  doc.save(`CMU-PlanPagos-${slug}.pdf`);
}

// ===== Vehicle Form =====
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

  const vAny = vehicle as any;
  const [form, setForm] = useState({
    marca: vehicle?.marca || "",
    modelo: vehicle?.modelo || "",
    variante: vehicle?.variante || "",
    anio: vehicle?.anio || new Date().getFullYear(),
    color: vehicle?.color || "",
    niv: vehicle?.niv || "",
    placas: vehicle?.placas || "",
    numSerie: vehicle?.numSerie || "",
    numMotor: vAny?.numMotor || "",
    cmuValor: vehicle?.cmuValor || 0,
    costoAdquisicion: vehicle?.costoAdquisicion || 0,
    costoReparacion: vehicle?.costoReparacion || 0,
    precioAseguradora: vAny?.precioAseguradora || vehicle?.costoAdquisicion || 0,
    reparacionEstimada: vAny?.reparacionEstimada || vehicle?.costoReparacion || 0,
    reparacionReal: vAny?.reparacionReal || null as number | null,
    conTanque: vAny?.conTanque ?? 1,
    status: vehicle?.status || "disponible",
    kitGnvInstalado: vehicle?.kitGnvInstalado || 0,
    kitGnvCosto: vehicle?.kitGnvCosto || 0,
    kitGnvMarca: vAny?.kitGnvMarca || "",
    kitGnvSerie: vAny?.kitGnvSerie || "",
    tanqueTipo: vAny?.tanqueTipo || "",
    tanqueMarca: vAny?.tanqueMarca || "",
    tanqueSerie: vAny?.tanqueSerie || "",
    tanqueCosto: vAny?.tanqueCosto || 0,
    gnvModalidad: vAny?.gnvModalidad || vAny?.gnv_modalidad || "kit_tanque",
    descuentoGnv: vAny?.descuentoGnv || vAny?.descuento_gnv || 0,
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

  // Live recalculation with GNV modalidad
  const repairForCalc = form.reparacionReal ?? form.reparacionEstimada ?? form.costoReparacion;
  const gnvBase = (form.kitGnvCosto || 18000) + (form.tanqueCosto || 9400);
  const gnvEffective = form.gnvModalidad === "incluido" ? gnvBase  // CMU absorbs but it's still a cost
    : form.gnvModalidad === "kit_reusado" ? (form.kitGnvCosto || 18000)
    : form.gnvModalidad === "descuento" ? Math.max(0, gnvBase - (form.descuentoGnv || 0))
    : gnvBase; // kit_tanque (default)
  const totalCostCalc = (form.precioAseguradora || form.costoAdquisicion || 0) + (repairForCalc || 0) + gnvEffective;
  const marginCalc = (form.cmuValor || 0) - totalCostCalc;

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const now = new Date().toISOString();
      // Send BOTH camelCase and snake_case to ensure storage UPDATE picks them up
      const payload: any = {
        marca: form.marca,
        modelo: form.modelo,
        variante: form.variante || null,
        anio: form.anio,
        color: form.color || null,
        niv: form.niv || null,
        placas: form.placas || null,
        num_serie: form.numSerie || null,
        num_motor: form.numMotor || null,
        // Financial — send snake_case (DB column names)
        cmu_valor: form.cmuValor || null,
        costo_adquisicion: form.costoAdquisicion || form.precioAseguradora || null,
        costo_reparacion: repairForCalc || form.costoReparacion || null,
        precio_aseguradora: form.precioAseguradora || null,
        reparacion_estimada: form.reparacionEstimada || null,
        reparacion_real: form.reparacionReal || null,
        con_tanque: form.conTanque,
        margen_estimado: marginCalc || null,
        status: form.status,
        kit_gnv_instalado: form.kitGnvInstalado,
        kit_gnv_costo: form.kitGnvCosto || null,
        kit_gnv_marca: form.kitGnvMarca || null,
        kit_gnv_serie: form.kitGnvSerie || null,
        tanque_tipo: form.tanqueTipo || null,
        tanque_marca: form.tanqueMarca || null,
        tanque_serie: form.tanqueSerie || null,
        tanque_costo: form.tanqueCosto || null,
        gnv_modalidad: form.gnvModalidad || "kit_tanque",
        descuento_gnv: form.descuentoGnv || null,
        notes: form.notes || null,
        updated_at: now,
      };

      if (vehicle) {
        await apiUpdateVehicle(vehicle.id, payload);
        toast({ title: "Vehículo actualizado" });
      } else {
        await apiCreateVehicle({ ...payload, created_at: now });
        toast({ title: "Vehículo agregado" });
      }
      onSaved();
      onClose();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  }, [form, vehicle, toast, onSaved, onClose, repairForCalc, marginCalc]);

  const update = (field: string, value: any) => setForm((p) => ({ ...p, [field]: value }));

  return (
    <div className="space-y-4 text-sm">
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
          <Select value={form.marca} onValueChange={(v) => { update("marca", v); update("modelo", ""); }}>
            <SelectTrigger><SelectValue placeholder="Marca" /></SelectTrigger>
            <SelectContent>
              {Array.from(new Set(catalogEntries.map((m) => m.brand))).sort().map((brand) => (
                <SelectItem key={brand} value={brand}>{brand}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Modelo</label>
          <Select value={form.modelo} onValueChange={(v) => update("modelo", v)}>
            <SelectTrigger><SelectValue placeholder="Modelo" /></SelectTrigger>
            <SelectContent>
              {Array.from(new Set(catalogEntries.filter((m) => !form.marca || m.brand === form.marca).map((m) => m.model))).sort().map((model) => (
                <SelectItem key={model} value={model}>{model}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Variante</label>
          <Input value={form.variante} onChange={(e) => update("variante", e.target.value)} placeholder="Ej: Sense" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Año</label>
          <Input type="number" value={form.anio} onChange={(e) => update("anio", parseInt(e.target.value) || 2023)} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Color</label><Input value={form.color} onChange={(e) => update("color", e.target.value)} /></div>
        <div><label className="text-xs font-medium text-muted-foreground mb-1 block">NIV</label><Input value={form.niv} onChange={(e) => update("niv", e.target.value)} className="font-mono text-xs" /></div>
        <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Placas</label><Input value={form.placas} onChange={(e) => update("placas", e.target.value)} /></div>
        <div><label className="text-xs font-medium text-muted-foreground mb-1 block">No. Serie</label><Input value={form.numSerie} onChange={(e) => update("numSerie", e.target.value)} className="font-mono text-xs" /></div>
        <div><label className="text-xs font-medium text-muted-foreground mb-1 block">No. Motor</label><Input value={form.numMotor} onChange={(e) => update("numMotor", e.target.value)} className="font-mono text-xs" /></div>
      </div>

      {/* Financial section */}
      <div className="border-t pt-4">
        <h4 className="text-xs font-semibold mb-3 flex items-center gap-1.5">
          <Calculator className="w-3.5 h-3.5" /> Datos Financieros
        </h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">CMU / Valor Mercado</label>
            <Input type="number" value={form.cmuValor || ""} onChange={(e) => update("cmuValor", parseInt(e.target.value) || 0)} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Precio Aseguradora</label>
            <Input type="number" value={form.precioAseguradora || ""} onChange={(e) => update("precioAseguradora", parseInt(e.target.value) || 0)} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Reparación Estimada
              {form.reparacionEstimada > 0 && <span className="text-muted-foreground font-normal"> (Motor CMU)</span>}
            </label>
            <Input type="number" value={form.reparacionEstimada || ""} onChange={(e) => update("reparacionEstimada", parseInt(e.target.value) || 0)} className="bg-muted/30" />
          </div>
          <div>
            <label className="text-xs font-medium text-amber-600 mb-1 block">
              Reparación Real
              <span className="text-muted-foreground font-normal"> (ajustar aquí)</span>
            </label>
            <Input
              type="number"
              value={form.reparacionReal ?? ""}
              onChange={(e) => update("reparacionReal", e.target.value ? parseInt(e.target.value) : null)}
              placeholder={form.reparacionEstimada ? `Estimado: ${formatMXN(form.reparacionEstimada)}` : "Sin estimado"}
              className="border-amber-300 focus:ring-amber-400"
              data-testid="input-reparacion-real"
            />
          </div>
        </div>

        {/* GNV Modalidad (HU-4) */}
        <div className="mt-3 p-3 rounded-lg border bg-muted/20 space-y-2">
          <div className="flex items-center gap-2 mb-2">
            <Fuel className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">Modalidad GNV</span>
            <span className="text-[10px] text-muted-foreground ml-auto">Costo GNV: {formatMXN(gnvEffective)}</span>
          </div>
          <Select value={form.gnvModalidad} onValueChange={(v) => update("gnvModalidad", v)}>
            <SelectTrigger className="text-xs h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="kit_tanque">Kit + Tanque nuevo ({formatMXN(gnvBase)})</SelectItem>
              <SelectItem value="kit_reusado">Kit solo — entrega cilindro ({formatMXN(form.kitGnvCosto || 18000)})</SelectItem>
              <SelectItem value="incluido">GNV incluido en PV (CMU absorbe)</SelectItem>
              <SelectItem value="descuento">Descuento custom</SelectItem>
            </SelectContent>
          </Select>
          {form.gnvModalidad === "descuento" && (
            <div>
              <label className="text-[10px] text-muted-foreground">Monto descuento GNV</label>
              <Input type="number" value={form.descuentoGnv || ""} onChange={(e) => update("descuentoGnv", parseInt(e.target.value) || 0)} className="h-8 text-xs" placeholder="Ej: 9400" />
            </div>
          )}
        </div>

        {/* Live recalculation preview */}
        {form.cmuValor > 0 && (form.precioAseguradora > 0 || form.costoAdquisicion > 0) && (
          <div className={`mt-3 p-3 rounded-lg border text-xs ${marginCalc >= 40000 ? "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200" : marginCalc >= 25000 ? "bg-amber-50 dark:bg-amber-950/30 border-amber-200" : "bg-red-50 dark:bg-red-950/30 border-red-200"}`}>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-[9px] text-muted-foreground">Costo Total</p>
                <p className="font-bold tabular-nums">{formatMXN(totalCostCalc)}</p>
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground">Margen</p>
                <p className={`font-bold tabular-nums ${marginCalc >= 40000 ? "text-emerald-600" : marginCalc >= 25000 ? "text-amber-600" : "text-red-600"}`}>{formatMXN(marginCalc)}</p>
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground">Usando</p>
                <p className="font-medium">{form.reparacionReal != null ? "Rep. Real" : "Rep. Estimada"}</p>
              </div>
            </div>
            {form.reparacionReal != null && form.reparacionEstimada > 0 && (
              <p className="text-[9px] text-center mt-1 text-muted-foreground">
                Δ reparación: {formatMXN(form.reparacionReal - form.reparacionEstimada)} vs estimado original
              </p>
            )}
          </div>
        )}
      </div>

      {/* Status */}
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Status</label>
        <Select value={form.status} onValueChange={(v) => update("status", v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
              <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Kit GNV */}
      <div className="border-t pt-4">
        <h4 className="text-xs font-semibold mb-3 flex items-center gap-1.5"><Fuel className="w-3.5 h-3.5" /> Kit GNV & Tanque</h4>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Kit Marca</label><Input value={form.kitGnvMarca} onChange={(e) => update("kitGnvMarca", e.target.value)} /></div>
          <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Kit Serie</label><Input value={form.kitGnvSerie} onChange={(e) => update("kitGnvSerie", e.target.value)} className="font-mono text-xs" /></div>
          <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Tanque Tipo</label>
            <Select value={form.tanqueTipo} onValueChange={(v) => update("tanqueTipo", v)}>
              <SelectTrigger><SelectValue placeholder="Tipo" /></SelectTrigger>
              <SelectContent><SelectItem value="reusado">Reusado</SelectItem><SelectItem value="nuevo">Nuevo</SelectItem></SelectContent>
            </Select>
          </div>
          <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Tanque Marca</label><Input value={form.tanqueMarca} onChange={(e) => update("tanqueMarca", e.target.value)} /></div>
        </div>
      </div>

      {/* Notes */}
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Notas</label>
        <Input value={form.notes} onChange={(e) => update("notes", e.target.value)} placeholder="Observaciones..." />
      </div>

      <Button className="w-full gap-2" onClick={handleSave} disabled={!form.marca || !form.modelo || isSaving} data-testid="button-save-vehicle">
        {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
        {vehicle ? "Guardar Cambios" : "Agregar Vehículo"}
      </Button>
    </div>
  );
}

// ===== Helper: run evaluation for a vehicle =====
function runEvalForVehicle(v: VehicleInventory): EvaluationResult | null {
  const vAny = v as any;
  const cmu = v.cmuValor;
  const insurer = vAny.precioAseguradora || v.costoAdquisicion;
  const repair = vAny.reparacionReal ?? vAny.reparacionEstimada ?? v.costoReparacion;
  const conTanqueVal = vAny.conTanque ?? 1;

  if (!cmu || !insurer) return null;

  try {
    return evaluateOpportunity(
      {
        modelId: v.id,
        modelSlug: v.modelo.toLowerCase().replace(/\s+/g, "-"),
        year: v.anio,
        cmu,
        insurerPrice: insurer,
        repairEstimate: repair || 0,
        conTanque: conTanqueVal === 1,
        city: "Aguascalientes",
      },
      {
        brand: v.marca,
        model: v.modelo,
        variant: v.variante || null,
        slug: v.modelo.toLowerCase().replace(/\s+/g, "-"),
        purchaseBenchmarkPct: 0.6,
      }
    );
  } catch {
    return null;
  }
}

// ===== Main Page =====
export default function InventarioPage() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("todos");
  const [showForm, setShowForm] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<VehicleInventory | undefined>();
  const [vehicles, setVehicles] = useState<VehicleInventory[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    apiListVehicles().then(setVehicles).catch(console.error);
    const unsubscribe = subscribe(() => {
      apiListVehicles().then(setVehicles).catch(console.error);
    });
    return unsubscribe;
  }, [refreshKey]);

  const filtered = (vehicles || []).filter((v) => {
    if (statusFilter !== "todos" && v.status !== statusFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const text = `${v.marca} ${v.modelo} ${v.variante || ""} ${v.anio} ${v.placas || ""} ${v.niv || ""}`.toLowerCase();
      const price = v.cmuValor || 0;
      const margin = (v as any).margenEstimado || 0;
      if (text.includes(q)) return true;
      if (q.startsWith(">") && price > parseInt(q.slice(1))) return true;
      if (q.startsWith("<") && price < parseInt(q.slice(1))) return true;
      return false;
    }
    return true;
  });

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

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Buscar por marca, modelo, placas, año..."
          className="pl-8 h-8 text-xs"
          data-testid="input-search-inventory"
        />
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
            const hasAcquisitionData = !!(vAny.precioAseguradora || v.costoAdquisicion) && !!v.cmuValor;
            const repReal = vAny.reparacionReal;
            const repEst = vAny.reparacionEstimada || v.costoReparacion;
            const isExpanded = expandedId === v.id;

            // Live eval for this vehicle
            const evalResult = hasAcquisitionData ? runEvalForVehicle(v) : null;

            return (
              <Card key={v.id} className="hover:bg-muted/20 transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-sm font-semibold">
                          {v.marca} {v.modelo} {v.variante || ""} {v.anio}
                        </span>
                        <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${statusCfg.color}`}>
                          {statusCfg.label}
                        </Badge>
                        {v.kitGnvInstalado === 1 && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">GNV</Badge>
                        )}
                        {evalResult && (
                          <>
                            <Badge
                              variant="outline"
                              className={`text-[10px] px-1.5 py-0 ${evalResult.decision === "COMPRAR" ? "border-emerald-400 text-emerald-700" : evalResult.decision === "VIABLE" ? "border-amber-400 text-amber-700" : "border-red-400 text-red-700"}`}
                            >
                              {evalResult.decision} · TIR {formatPctDec(evalResult.tirBase)}
                            </Badge>
                            {evalResult.tirBase < STANDARD.tirBaseMinima && (
                              <Badge variant="destructive" className="text-[10px] px-1.5 py-0">TIR bajo mínimo</Badge>
                            )}
                          </>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {v.placas && <span>Placas: {v.placas}</span>}
                        {v.color && <span>Color: {v.color}</span>}
                        {v.niv && <span className="font-mono text-[10px]">NIV: {v.niv}</span>}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-xs">
                        <span className="text-muted-foreground">CMU: <strong className="text-foreground">{formatMXN(v.cmuValor)}</strong></span>
                        <span className="text-muted-foreground">Aseg: <strong className="text-foreground">{formatMXN(vAny.precioAseguradora || v.costoAdquisicion)}</strong></span>
                        {repEst > 0 && (
                          <span className="text-muted-foreground">
                            Rep: <strong className={repReal != null ? "text-amber-600" : "text-foreground"}>
                              {repReal != null ? formatMXN(repReal) : formatMXN(repEst)}
                            </strong>
                            {repReal != null && repEst > 0 && (
                              <span className="text-[10px] ml-1">(est. {formatMXN(repEst)})</span>
                            )}
                          </span>
                        )}
                        {evalResult && (
                          <span className="text-muted-foreground">
                            Margen: <strong className={`${evalResult.margin >= 40000 ? "text-emerald-600" : evalResult.margin >= 25000 ? "text-amber-600" : "text-red-600"}`}>
                              {formatMXN(evalResult.margin)}
                            </strong>
                          </span>
                        )}
                      </div>
                      {v.notes && (
                        <p className="text-[10px] text-muted-foreground mt-1.5">{v.notes}</p>
                      )}
                    </div>
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      <button
                        onClick={() => handleEdit(v)}
                        className="p-2 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        data-testid={`button-edit-vehicle-${v.id}`}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      {hasAcquisitionData && (
                        <button
                          onClick={() => setExpandedId(isExpanded ? null : v.id)}
                          className="p-2 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          data-testid={`button-expand-vehicle-${v.id}`}
                        >
                          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded: quick actions + mini corrida */}
                  {isExpanded && evalResult && (
                    <div className="mt-3 pt-3 border-t space-y-3">
                      {/* 3 TIRs mini */}
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { label: "TIR Base", val: evalResult.tirBase, threshold: 0.299 },
                          { label: "TIR Operativa", val: evalResult.tirOperativa },
                          { label: "TIR Completa", val: evalResult.tirCompleta },
                        ].map((t, i) => (
                          <div key={i} className={`text-center p-2 rounded-lg border ${t.threshold && t.val < t.threshold ? "bg-red-50 border-red-200" : "bg-emerald-50 border-emerald-200"}`}>
                            <p className="text-[9px] text-muted-foreground">{t.label}</p>
                            <p className={`text-sm font-bold ${t.threshold && t.val < t.threshold ? "text-red-600" : "text-emerald-600"}`}>{formatPctDec(t.val)}</p>
                          </div>
                        ))}
                      </div>

                      {/* Quick summary */}
                      <div className="grid grid-cols-4 gap-2 text-center text-xs">
                        <div><p className="text-[9px] text-muted-foreground">Cuota 1</p><p className="font-semibold tabular-nums">{formatMXN(evalResult.cuotaMes1)}</p></div>
                        <div><p className="text-[9px] text-muted-foreground">Cuota 36</p><p className="font-semibold tabular-nums">{formatMXN(evalResult.cuotaMes36)}</p></div>
                        <div><p className="text-[9px] text-muted-foreground">MOIC</p><p className="font-semibold">{evalResult.moic.toFixed(2)}x</p></div>
                        <div><p className="text-[9px] text-muted-foreground">Dif. m36</p><p className="font-semibold">{formatMXN(Math.max(0, evalResult.cuotaMes36 - 4400))}</p></div>
                      </div>

                      {/* Corrida button */}
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full gap-2"
                        onClick={() => {
                          try {
                            generateCorridaPdf(v, evalResult);
                            toast({ title: "Plan de Pagos generado", description: `PDF descargado: ${v.marca} ${v.modelo} ${v.anio}` });
                          } catch (err: any) {
                            toast({ title: "Error al generar corrida", description: err.message, variant: "destructive" });
                          }
                        }}
                        data-testid={`button-corrida-${v.id}`}
                      >
                        <FileText className="w-3.5 h-3.5" />
                        Generar Plan de Pagos
                      </Button>
                    </div>
                  )}
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
