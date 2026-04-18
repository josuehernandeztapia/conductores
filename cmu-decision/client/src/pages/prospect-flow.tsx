/**
 * prospect-flow.tsx — Registro de prospecto (vista Ángeles / promotora)
 *
 * Flujo de 7 pasos:
 *   1. Datos del taxista
 *   2. Combustible (GNV / Gasolina)
 *   3. Consumo mensual
 *   4. Seleccionar modelo (from /api/inventory)
 *   5. Kit GNV (si aplica)
 *   6. Corrida estimada (German amortization)
 *   7. Confirmación / folio
 */

import { useState, useMemo, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Car,
  Flame,
  Fuel,
  Loader2,
  Wallet,
  PartyPopper,
  ExternalLink,
  ChevronRight,
} from "lucide-react";
import { calcularCorrida, formatMXN, SOBREPRECIO_GNV } from "@/lib/corrida";
import { useToast } from "@/hooks/use-toast";

// ─── Types ────────────────────────────────────────────────────────────────────

interface VehicleInventory {
  id: number;
  brand: string;
  model: string;
  variant?: string;
  year: number;
  cmu: number; // CMU sale price
  status: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TOTAL_STEPS = 7;
const MIN_LEQ = 400;
const MIN_PESOS_MES = 9_600;

// ─── Step indicator ───────────────────────────────────────────────────────────

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-1.5 mb-6" role="progressbar" aria-valuenow={current} aria-valuemax={total}>
      {Array.from({ length: total }, (_, i) => {
        const step = i + 1;
        const done = step < current;
        const active = step === current;
        return (
          <div
            key={step}
            className={[
              "rounded-full transition-all duration-200",
              active ? "w-6 h-2 bg-teal-500" : done ? "w-2 h-2 bg-teal-700" : "w-2 h-2 bg-zinc-700",
            ].join(" ")}
            aria-label={`Paso ${step}`}
          />
        );
      })}
    </div>
  );
}

// ─── Layout shell ─────────────────────────────────────────────────────────────

function StepShell({
  step,
  title,
  children,
  onNext,
  onBack,
  nextLabel = "Continuar",
  nextDisabled = false,
  loading = false,
  hideNext = false,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
  onNext?: () => void;
  onBack?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  loading?: boolean;
  hideNext?: boolean;
}) {
  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center px-4 py-6">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs text-zinc-500 font-medium uppercase tracking-widest">
            Paso {step} de {TOTAL_STEPS}
          </span>
          <span className="text-xs text-teal-500 font-semibold">CMU Prospecto</span>
        </div>

        <StepDots current={step} total={TOTAL_STEPS} />

        <Card className="bg-zinc-900 border-zinc-800 shadow-xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-zinc-100">{title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {children}

            {/* Navigation */}
            <div className="flex gap-2 pt-2">
              {onBack && (
                <Button
                  variant="outline"
                  className="flex-1 border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                  onClick={onBack}
                  disabled={loading}
                >
                  <ArrowLeft className="w-4 h-4 mr-1" />
                  Atrás
                </Button>
              )}
              {!hideNext && onNext && (
                <Button
                  className="flex-1 bg-teal-600 hover:bg-teal-500 text-white disabled:opacity-40"
                  onClick={onNext}
                  disabled={nextDisabled || loading}
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <ArrowRight className="w-4 h-4 mr-1" />
                  )}
                  {nextLabel}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Step 1: Datos del taxista ────────────────────────────────────────────────

interface DatosTaxista {
  nombre: string;
  apellido_paterno: string;
  apellido_materno: string;
  telefono: string;
}

function Step1Datos({
  datos,
  onChange,
  onNext,
}: {
  datos: DatosTaxista;
  onChange: (d: DatosTaxista) => void;
  onNext: () => void;
}) {
  const valid =
    datos.nombre.trim().length >= 2 &&
    datos.apellido_paterno.trim().length >= 2 &&
    /^\d{10}$/.test(datos.telefono);

  return (
    <StepShell step={1} title="Datos del taxista" onNext={onNext} nextDisabled={!valid}>
      <div className="space-y-3">
        <div>
          <Label className="text-zinc-300 text-sm mb-1 block">Nombre(s)</Label>
          <Input
            className="bg-zinc-800 border-zinc-700 text-zinc-100 placeholder:text-zinc-500"
            placeholder="Ej: Juan"
            value={datos.nombre}
            onChange={(e) => onChange({ ...datos, nombre: e.target.value })}
            autoFocus
            autoComplete="given-name"
          />
        </div>
        <div>
          <Label className="text-zinc-300 text-sm mb-1 block">Apellido paterno</Label>
          <Input
            className="bg-zinc-800 border-zinc-700 text-zinc-100 placeholder:text-zinc-500"
            placeholder="Ej: García"
            value={datos.apellido_paterno}
            onChange={(e) => onChange({ ...datos, apellido_paterno: e.target.value })}
            autoComplete="family-name"
          />
        </div>
        <div>
          <Label className="text-zinc-300 text-sm mb-1 block">Apellido materno</Label>
          <Input
            className="bg-zinc-800 border-zinc-700 text-zinc-100 placeholder:text-zinc-500"
            placeholder="Ej: López (opcional)"
            value={datos.apellido_materno}
            onChange={(e) => onChange({ ...datos, apellido_materno: e.target.value })}
            autoComplete="additional-name"
          />
        </div>
        <div>
          <Label className="text-zinc-300 text-sm mb-1 block">Teléfono (10 dígitos)</Label>
          <Input
            className="bg-zinc-800 border-zinc-700 text-zinc-100 placeholder:text-zinc-500"
            placeholder="5512345678"
            type="tel"
            inputMode="numeric"
            maxLength={10}
            value={datos.telefono}
            onChange={(e) => {
              const val = e.target.value.replace(/\D/g, "").slice(0, 10);
              onChange({ ...datos, telefono: val });
            }}
            autoComplete="tel"
          />
          {datos.telefono.length > 0 && datos.telefono.length < 10 && (
            <p className="text-xs text-amber-400 mt-1">Faltan {10 - datos.telefono.length} dígitos</p>
          )}
        </div>
      </div>
    </StepShell>
  );
}

// ─── Step 2: Combustible ──────────────────────────────────────────────────────

function Step2Combustible({
  fuel,
  onSelect,
  onBack,
  onNext,
}: {
  fuel: "gnv" | "gasolina" | null;
  onSelect: (f: "gnv" | "gasolina") => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <StepShell step={2} title="Tipo de combustible" onBack={onBack} onNext={onNext} nextDisabled={!fuel}>
      <div className="grid grid-cols-2 gap-3">
        {/* GNV */}
        <button
          onClick={() => onSelect("gnv")}
          className={[
            "flex flex-col items-center gap-2 py-6 rounded-xl border-2 transition-all",
            fuel === "gnv"
              ? "border-teal-500 bg-teal-900/30 text-teal-300"
              : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600",
          ].join(" ")}
        >
          <Flame className="w-8 h-8" />
          <span className="text-sm font-semibold">GNV</span>
          <span className="text-[11px] opacity-70">Gas natural</span>
        </button>

        {/* Gasolina */}
        <button
          onClick={() => onSelect("gasolina")}
          className={[
            "flex flex-col items-center gap-2 py-6 rounded-xl border-2 transition-all",
            fuel === "gasolina"
              ? "border-teal-500 bg-teal-900/30 text-teal-300"
              : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600",
          ].join(" ")}
        >
          <Fuel className="w-8 h-8" />
          <span className="text-sm font-semibold">Gasolina</span>
          <span className="text-[11px] opacity-70">Combustible líquido</span>
        </button>
      </div>

      {fuel && (
        <p className="text-xs text-zinc-500 text-center">
          {fuel === "gnv"
            ? "El ahorro en GNV financiará tu cuota mensual."
            : "El kit GNV nuevo está incluido en el precio."}
        </p>
      )}
    </StepShell>
  );
}

// ─── Step 3: Consumo ──────────────────────────────────────────────────────────

function Step3Consumo({
  fuel,
  consumo,
  onConsumo,
  onBack,
  onNext,
}: {
  fuel: "gnv" | "gasolina";
  consumo: string;
  onConsumo: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const isGnv = fuel === "gnv";
  const numVal = parseFloat(consumo);
  const valid = !isNaN(numVal) && (isGnv ? numVal >= MIN_LEQ : numVal >= MIN_PESOS_MES);

  return (
    <StepShell step={3} title={isGnv ? "Consumo de GNV" : "Gasto en gasolina"} onBack={onBack} onNext={onNext} nextDisabled={!valid}>
      <div className="space-y-3">
        <div>
          <Label className="text-zinc-300 text-sm mb-1 block">
            {isGnv ? "LEQ al mes" : "Pesos al mes ($)"}
          </Label>
          <Input
            className="bg-zinc-800 border-zinc-700 text-zinc-100 placeholder:text-zinc-500 text-lg font-mono"
            type="number"
            inputMode="numeric"
            min={isGnv ? MIN_LEQ : MIN_PESOS_MES}
            placeholder={isGnv ? "Ej: 600" : "Ej: 12000"}
            value={consumo}
            onChange={(e) => onConsumo(e.target.value)}
            autoFocus
          />
          <p className="text-xs text-zinc-500 mt-1">
            Mínimo requerido:{" "}
            <span className="text-zinc-400 font-medium">
              {isGnv ? `${MIN_LEQ} LEQ/mes` : formatMXN(MIN_PESOS_MES) + "/mes"}
            </span>
          </p>
        </div>

        {isGnv && numVal >= MIN_LEQ && (
          <div className="rounded-lg bg-teal-900/20 border border-teal-800 p-3 text-sm">
            <p className="text-teal-300 font-medium">GNV cubre mensualmente</p>
            <p className="text-2xl font-bold text-teal-400 mt-0.5">
              {formatMXN(numVal * SOBREPRECIO_GNV)}
            </p>
            <p className="text-zinc-500 text-xs mt-0.5">
              {numVal} LEQ × ${SOBREPRECIO_GNV}/LEQ
            </p>
          </div>
        )}

        {!isGnv && numVal >= MIN_PESOS_MES && (
          <div className="rounded-lg bg-zinc-800 border border-zinc-700 p-3 text-sm">
            <p className="text-zinc-400">Conversión estimada a LEQ</p>
            <p className="text-xl font-bold text-zinc-200 mt-0.5">
              {Math.round(numVal / SOBREPRECIO_GNV)} LEQ/mes
            </p>
            <p className="text-zinc-500 text-xs mt-0.5">a ${SOBREPRECIO_GNV}/LEQ</p>
          </div>
        )}
      </div>
    </StepShell>
  );
}

// ─── Step 4: Seleccionar modelo ───────────────────────────────────────────────

function VehicleCard({
  vehicle,
  selected,
  onSelect,
}: {
  vehicle: VehicleInventory;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={[
        "w-full text-left p-3 rounded-xl border-2 transition-all flex items-center gap-3",
        selected
          ? "border-teal-500 bg-teal-900/20"
          : "border-zinc-700 bg-zinc-800 hover:border-zinc-600",
      ].join(" ")}
    >
      <div className={["w-9 h-9 rounded-lg flex items-center justify-center shrink-0", selected ? "bg-teal-500/20" : "bg-zinc-700"].join(" ")}>
        <Car className={["w-5 h-5", selected ? "text-teal-400" : "text-zinc-400"].join(" ")} />
      </div>
      <div className="flex-1 min-w-0">
        <p className={["text-sm font-semibold leading-tight", selected ? "text-teal-200" : "text-zinc-200"].join(" ")}>
          {vehicle.brand} {vehicle.model}
        </p>
        {vehicle.variant && (
          <p className="text-xs text-zinc-500 truncate">{vehicle.variant}</p>
        )}
        <p className="text-xs text-zinc-400">{vehicle.year}</p>
      </div>
      <div className="text-right shrink-0">
        <p className={["text-sm font-bold", selected ? "text-teal-400" : "text-zinc-300"].join(" ")}>
          {formatMXN(vehicle.cmu)}
        </p>
        <p className="text-[10px] text-zinc-500">precio CMU</p>
      </div>
      {selected && <CheckCircle2 className="w-4 h-4 text-teal-500 shrink-0" />}
    </button>
  );
}

function Step4Modelo({
  selectedId,
  onSelect,
  onBack,
  onNext,
}: {
  selectedId: number | null;
  onSelect: (v: VehicleInventory) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [vehicles, setVehicles] = useState<VehicleInventory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/inventory")
      .then((r) => {
        if (!r.ok) throw new Error("Error cargando inventario");
        return r.json();
      })
      .then((data: VehicleInventory[]) => {
        if (cancelled) return;
        // Only show available units
        const available = data.filter((v) => v.status === "disponible");
        setVehicles(available);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e.message || "No se pudo cargar el inventario");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <StepShell
      step={4}
      title="Seleccionar modelo"
      onBack={onBack}
      onNext={onNext}
      nextDisabled={selectedId === null}
    >
      {loading && (
        <div className="flex items-center justify-center py-8 gap-2 text-zinc-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Cargando inventario…</span>
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-900/20 border border-red-800 p-3 text-sm text-red-300">
          {error}
          <button
            className="block text-xs text-red-400 underline mt-1"
            onClick={() => window.location.reload()}
          >
            Reintentar
          </button>
        </div>
      )}

      {!loading && !error && vehicles.length === 0 && (
        <p className="text-center text-zinc-500 py-6 text-sm">
          No hay unidades disponibles en inventario.
        </p>
      )}

      {!loading && vehicles.length > 0 && (
        <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
          {vehicles.map((v) => (
            <VehicleCard
              key={v.id}
              vehicle={v}
              selected={selectedId === v.id}
              onSelect={() => onSelect(v)}
            />
          ))}
        </div>
      )}
    </StepShell>
  );
}

// ─── Step 5: Kit GNV ──────────────────────────────────────────────────────────

function Step5Kit({
  fuel,
  kitNuevo,
  onKit,
  onBack,
  onNext,
}: {
  fuel: "gnv" | "gasolina";
  kitNuevo: boolean | null;
  onKit: (v: boolean) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  // Gasolina always uses new kit (skip logic handled in parent)
  if (fuel === "gasolina") {
    return (
      <StepShell step={5} title="Kit GNV incluido" onBack={onBack} onNext={onNext}>
        <div className="rounded-xl bg-zinc-800 border border-zinc-700 p-4 text-center">
          <CheckCircle2 className="w-10 h-10 text-teal-400 mx-auto mb-2" />
          <p className="text-zinc-200 font-medium">Kit nuevo incluido en el precio</p>
          <p className="text-xs text-zinc-500 mt-1">
            Para clientes que cambian de gasolina a GNV, el kit de conversión nuevo
            está incluido sin costo adicional visible.
          </p>
        </div>
      </StepShell>
    );
  }

  return (
    <StepShell
      step={5}
      title="Kit GNV"
      onBack={onBack}
      onNext={onNext}
      nextDisabled={kitNuevo === null}
    >
      <p className="text-zinc-400 text-sm mb-1">
        ¿El taxista reutilizará su tanque actual o prefiere un kit nuevo?
      </p>

      <div className="space-y-2">
        <button
          onClick={() => onKit(false)}
          className={[
            "w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left",
            kitNuevo === false
              ? "border-teal-500 bg-teal-900/20"
              : "border-zinc-700 bg-zinc-800 hover:border-zinc-600",
          ].join(" ")}
        >
          <div className={["w-9 h-9 rounded-lg flex items-center justify-center shrink-0", kitNuevo === false ? "bg-teal-500/20" : "bg-zinc-700"].join(" ")}>
            <Flame className={["w-5 h-5", kitNuevo === false ? "text-teal-400" : "text-zinc-400"].join(" ")} />
          </div>
          <div className="flex-1">
            <p className={["text-sm font-semibold", kitNuevo === false ? "text-teal-200" : "text-zinc-200"].join(" ")}>
              Reusar tanque
            </p>
            <p className="text-xs text-zinc-500">Sin costo adicional por kit</p>
          </div>
          {kitNuevo === false && <CheckCircle2 className="w-4 h-4 text-teal-500 shrink-0" />}
        </button>

        <button
          onClick={() => onKit(true)}
          className={[
            "w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left",
            kitNuevo === true
              ? "border-teal-500 bg-teal-900/20"
              : "border-zinc-700 bg-zinc-800 hover:border-zinc-600",
          ].join(" ")}
        >
          <div className={["w-9 h-9 rounded-lg flex items-center justify-center shrink-0", kitNuevo === true ? "bg-teal-500/20" : "bg-zinc-700"].join(" ")}>
            <Wallet className={["w-5 h-5", kitNuevo === true ? "text-teal-400" : "text-zinc-400"].join(" ")} />
          </div>
          <div className="flex-1">
            <p className={["text-sm font-semibold", kitNuevo === true ? "text-teal-200" : "text-zinc-200"].join(" ")}>
              Kit nuevo
            </p>
            <p className="text-xs text-zinc-500">$9,400 adicional al precio del vehículo</p>
          </div>
          {kitNuevo === true && <CheckCircle2 className="w-4 h-4 text-teal-500 shrink-0" />}
        </button>
      </div>
    </StepShell>
  );
}

// ─── Step 6: Corrida estimada ─────────────────────────────────────────────────

function Step6Corrida({
  vehicle,
  fuel,
  consumo,
  kitNuevo,
  onBack,
  onNext,
}: {
  vehicle: VehicleInventory;
  fuel: "gnv" | "gasolina";
  consumo: string;
  kitNuevo: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  // For gasolina: convert pesos to LEQ for gnvCubre calculation
  const consumoLEQ = useMemo(() => {
    if (fuel === "gnv") return parseFloat(consumo) || 0;
    const pesos = parseFloat(consumo) || 0;
    return Math.round(pesos / SOBREPRECIO_GNV);
  }, [fuel, consumo]);

  const pvFinal = useMemo(() => {
    // Gasolina: kit nuevo always included in price (no surcharge here)
    // GNV + kit nuevo: adds $9,400
    if (fuel === "gnv" && kitNuevo) return vehicle.cmu + 9_400;
    return vehicle.cmu;
  }, [vehicle.cmu, fuel, kitNuevo]);

  const corrida = useMemo(() =>
    calcularCorrida({
      pvCMU: pvFinal,
      consumoLEQ,
      kitNuevo: fuel === "gnv" ? kitNuevo : false,
    }),
    [pvFinal, consumoLEQ, kitNuevo, fuel]
  );

  // Show first 3 rows + month where GNV covers 100% + last row
  const displayRows = useMemo(() => {
    const all = corrida.rows;
    if (all.length <= 6) return all;
    const shown = new Set([0, 1, 2]);
    if (corrida.mesGnvCubre100 > 0) shown.add(corrida.mesGnvCubre100 - 1);
    shown.add(all.length - 1);
    return Array.from(shown).sort((a, b) => a - b).map((i) => ({ row: all[i], ellipsisBefore: false }));
  }, [corrida]);

  const mes1 = corrida.rows[0];

  return (
    <StepShell
      step={6}
      title="Corrida estimada"
      onBack={onBack}
      onNext={onNext}
      nextLabel="Registrar"
    >
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="rounded-lg bg-zinc-800 border border-zinc-700 p-3">
          <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Precio vehículo</p>
          <p className="text-base font-bold text-zinc-100">{formatMXN(pvFinal)}</p>
          <p className="text-[10px] text-zinc-600">{vehicle.brand} {vehicle.model} {vehicle.year}</p>
        </div>
        <div className="rounded-lg bg-zinc-800 border border-zinc-700 p-3">
          <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Total a plazos</p>
          <p className="text-base font-bold text-zinc-100">{formatMXN(corrida.totalPlazos)}</p>
          <p className="text-[10px] text-zinc-600">36 meses</p>
        </div>
        <div className="rounded-lg bg-teal-900/30 border border-teal-800 p-3">
          <p className="text-[11px] text-teal-500 uppercase tracking-wide">Cuota mes 1</p>
          <p className="text-base font-bold text-teal-300">{formatMXN(mes1.cuota)}</p>
          <p className="text-[10px] text-teal-700/80">capital + interés</p>
        </div>
        <div className="rounded-lg bg-zinc-800 border border-zinc-700 p-3">
          <p className="text-[11px] text-zinc-500 uppercase tracking-wide">GNV cubre</p>
          <p className="text-base font-bold text-zinc-100">{formatMXN(mes1.gnvCubre)}</p>
          <p className="text-[10px] text-zinc-600">{consumoLEQ} LEQ/mes</p>
        </div>
      </div>

      {corrida.mesGnvCubre100 > 0 ? (
        <div className="rounded-lg bg-emerald-900/20 border border-emerald-800 p-2.5 mb-3 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <p className="text-xs text-emerald-300">
            Desde el mes <strong>{corrida.mesGnvCubre100}</strong>, el GNV cubre el 100% de la cuota.
          </p>
        </div>
      ) : (
        <div className="rounded-lg bg-amber-900/20 border border-amber-800 p-2.5 mb-3">
          <p className="text-xs text-amber-300">
            Con este consumo, el GNV no cubre la cuota completa en ningún mes.
            El taxista siempre aportará algo de bolsillo.
          </p>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-right">
          <thead>
            <tr className="text-zinc-500 border-b border-zinc-800">
              <th className="text-left py-1.5 font-medium">Mes</th>
              <th className="py-1.5 font-medium">Cuota</th>
              <th className="py-1.5 font-medium text-teal-500">GNV cubre</th>
              <th className="py-1.5 font-medium text-amber-400">De bolsillo</th>
              <th className="py-1.5 font-medium">Saldo</th>
            </tr>
          </thead>
          <tbody>
            {corrida.rows.slice(0, 36).reduce<{ rows: typeof corrida.rows; shown: React.ReactNode[] }>(
              (acc, row, idx) => {
                const isFirst3 = idx < 3;
                const isCubre100 = corrida.mesGnvCubre100 > 0 && row.mes === corrida.mesGnvCubre100;
                const isLast = idx === corrida.rows.length - 1;
                const shouldShow = isFirst3 || isCubre100 || isLast;

                if (shouldShow) {
                  // If there's a gap, show ellipsis
                  const lastShownIdx = acc.rows.length > 0 ? acc.rows[acc.rows.length - 1].mes - 1 : -1;
                  if (lastShownIdx >= 0 && idx > lastShownIdx + 1) {
                    acc.shown.push(
                      <tr key={`ellipsis-${idx}`} className="text-zinc-700">
                        <td colSpan={5} className="py-1 text-center text-zinc-600">⋯</td>
                      </tr>
                    );
                  }
                  acc.rows.push(row);
                  acc.shown.push(
                    <tr
                      key={row.mes}
                      className={[
                        "border-b border-zinc-800/50 transition-colors",
                        isCubre100 ? "bg-emerald-900/10" : "",
                      ].join(" ")}
                    >
                      <td className="py-1.5 text-left">
                        <span className={["font-medium", isCubre100 ? "text-emerald-400" : "text-zinc-300"].join(" ")}>
                          {row.mes}
                        </span>
                        {isCubre100 && (
                          <Badge className="ml-1 bg-emerald-900/40 text-emerald-400 border-emerald-700 text-[9px] px-1 py-0">
                            100%
                          </Badge>
                        )}
                      </td>
                      <td className="py-1.5 text-zinc-300">{formatMXN(row.cuota)}</td>
                      <td className="py-1.5 text-teal-400">{formatMXN(row.gnvCubre)}</td>
                      <td className="py-1.5 text-amber-400">{formatMXN(row.deTuBolsillo)}</td>
                      <td className="py-1.5 text-zinc-500">{formatMXN(row.saldoFinal)}</td>
                    </tr>
                  );
                }
                return acc;
              },
              { rows: [], shown: [] }
            ).shown}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-zinc-600 mt-2">
        Tasa anual {(0.299 * 100).toFixed(1)}% · German amortization · 36 meses · {corrida.kitLabel}
      </p>
    </StepShell>
  );
}

// ─── Step 7: Confirmación ─────────────────────────────────────────────────────

function Step7Confirmacion({
  datos,
  vehicle,
  fuel,
  consumo,
  kitNuevo,
  onBack,
}: {
  datos: DatosTaxista;
  vehicle: VehicleInventory;
  fuel: "gnv" | "gasolina";
  consumo: string;
  kitNuevo: boolean;
  onBack: () => void;
}) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [folio, setFolio] = useState<string | null>(null);
  const [originacionId, setOriginacionId] = useState<number | null>(null);

  const consumoLEQ = useMemo(() => {
    if (fuel === "gnv") return parseFloat(consumo) || 0;
    return Math.round((parseFloat(consumo) || 0) / SOBREPRECIO_GNV);
  }, [fuel, consumo]);

  const handleRegistrar = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/originations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre: datos.nombre.trim(),
          apellido_paterno: datos.apellido_paterno.trim(),
          apellido_materno: datos.apellido_materno.trim(),
          telefono: datos.telefono,
          perfil_tipo: fuel === "gnv" ? "A" : "B",
          vehicle_inventory_id: vehicle.id,
          consumo_leq: consumoLEQ,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Error al registrar prospecto");
      }

      const data = await res.json();
      setFolio(data.folio);
      setOriginacionId(data.id);
    } catch (e: any) {
      toast({
        title: "Error al registrar",
        description: e.message || "Intenta de nuevo",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [datos, vehicle, fuel, consumoLEQ, toast]);

  // Success state
  if (folio && originacionId) {
    return (
      <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center px-4 py-6">
        <div className="w-full max-w-md">
          <Card className="bg-zinc-900 border-zinc-800 shadow-xl">
            <CardContent className="flex flex-col items-center py-8 gap-4">
              <div className="w-16 h-16 rounded-full bg-teal-900/40 flex items-center justify-center">
                <PartyPopper className="w-8 h-8 text-teal-400" />
              </div>
              <div className="text-center">
                <p className="text-xs text-zinc-500 uppercase tracking-widest mb-1">Folio registrado</p>
                <p className="text-3xl font-bold text-teal-400 font-mono">{folio}</p>
              </div>
              <div className="w-full rounded-lg bg-zinc-800 border border-zinc-700 p-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Taxista</span>
                  <span className="text-zinc-200 font-medium">
                    {datos.nombre} {datos.apellido_paterno}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Vehículo</span>
                  <span className="text-zinc-200 font-medium">
                    {vehicle.brand} {vehicle.model} {vehicle.year}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Combustible</span>
                  <span className="text-zinc-200 font-medium">{fuel === "gnv" ? "GNV" : "Gasolina"}</span>
                </div>
              </div>
              <Button
                className="w-full bg-teal-600 hover:bg-teal-500 text-white"
                onClick={() => setLocation(`/originacion/${originacionId}`)}
              >
                Continuar a documentos
                <ExternalLink className="w-4 h-4 ml-1.5" />
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Pre-registration review
  return (
    <StepShell
      step={7}
      title="Confirmar registro"
      onBack={onBack}
      onNext={handleRegistrar}
      nextLabel="Registrar"
      loading={loading}
    >
      <p className="text-zinc-400 text-sm mb-1">
        Revisa los datos antes de crear el folio.
      </p>

      <div className="rounded-lg bg-zinc-800 border border-zinc-700 divide-y divide-zinc-700 text-sm">
        <Row label="Nombre" value={`${datos.nombre} ${datos.apellido_paterno} ${datos.apellido_materno}`.trim()} />
        <Row label="Teléfono" value={datos.telefono} />
        <Row label="Combustible" value={fuel === "gnv" ? "GNV" : "Gasolina"} />
        <Row label="Consumo" value={fuel === "gnv" ? `${consumo} LEQ/mes` : `${formatMXN(parseFloat(consumo))}/mes`} />
        <Row label="Vehículo" value={`${vehicle.brand} ${vehicle.model} ${vehicle.year}`} />
        <Row label="Precio CMU" value={formatMXN(vehicle.cmu)} />
        {fuel === "gnv" && <Row label="Kit GNV" value={kitNuevo ? "Nuevo ($9,400)" : "Reusar tanque"} />}
      </div>
    </StepShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-200 font-medium text-right max-w-[60%]">{value}</span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ProspectFlow() {
  const [step, setStep] = useState(1);

  // Step 1
  const [datos, setDatos] = useState<DatosTaxista>({
    nombre: "",
    apellido_paterno: "",
    apellido_materno: "",
    telefono: "",
  });

  // Step 2
  const [fuel, setFuel] = useState<"gnv" | "gasolina" | null>(null);

  // Step 3
  const [consumo, setConsumo] = useState("");

  // Step 4
  const [vehicle, setVehicle] = useState<VehicleInventory | null>(null);

  // Step 5
  const [kitNuevo, setKitNuevo] = useState<boolean | null>(null);

  const next = useCallback(() => setStep((s) => Math.min(s + 1, TOTAL_STEPS)), []);
  const back = useCallback(() => setStep((s) => Math.max(s - 1, 1)), []);

  // Auto-skip step 5 logic: gasolina → always kitNuevo=true, skip to 6
  const handleFuelSelect = useCallback((f: "gnv" | "gasolina") => {
    setFuel(f);
    if (f === "gasolina") setKitNuevo(true);
    else setKitNuevo(null);
  }, []);

  // Step 5 → 6: for gasolina, step 5 is shown but auto-advances
  const handleStep5Next = useCallback(() => {
    if (fuel === "gasolina") {
      setKitNuevo(true);
    }
    next();
  }, [fuel, next]);

  switch (step) {
    case 1:
      return (
        <Step1Datos
          datos={datos}
          onChange={setDatos}
          onNext={next}
        />
      );

    case 2:
      return (
        <Step2Combustible
          fuel={fuel}
          onSelect={handleFuelSelect}
          onBack={back}
          onNext={next}
        />
      );

    case 3:
      return (
        <Step3Consumo
          fuel={fuel as "gnv" | "gasolina"}
          consumo={consumo}
          onConsumo={setConsumo}
          onBack={back}
          onNext={next}
        />
      );

    case 4:
      return (
        <Step4Modelo
          selectedId={vehicle?.id ?? null}
          onSelect={setVehicle}
          onBack={back}
          onNext={next}
        />
      );

    case 5:
      return (
        <Step5Kit
          fuel={fuel as "gnv" | "gasolina"}
          kitNuevo={kitNuevo}
          onKit={setKitNuevo}
          onBack={back}
          onNext={handleStep5Next}
        />
      );

    case 6:
      return (
        <Step6Corrida
          vehicle={vehicle!}
          fuel={fuel as "gnv" | "gasolina"}
          consumo={consumo}
          kitNuevo={kitNuevo!}
          onBack={back}
          onNext={next}
        />
      );

    case 7:
      return (
        <Step7Confirmacion
          datos={datos}
          vehicle={vehicle!}
          fuel={fuel as "gnv" | "gasolina"}
          consumo={consumo}
          kitNuevo={kitNuevo!}
          onBack={back}
        />
      );

    default:
      return null;
  }
}
