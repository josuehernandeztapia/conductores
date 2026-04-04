/**
 * Corrida Estimada — Para prospectos por WhatsApp
 * 
 * Genera una corrida simplificada con amortización alemana + anticipo mes 2.
 * Usa precios promedio de mercado con regla PV máxima.
 * NO es definitiva — es para enganchar al prospecto.
 */

// Constants (same as evaluation-engine.ts)
const TASA_ANUAL = 0.299;
const TASA_MENSUAL = TASA_ANUAL / 12;
const PLAZO = 36;
const ANTICIPO = 50000;
const MES_ANTICIPO = 2;
const FONDO_MENSUAL = 334;
const FONDO_INICIAL = 8000;
const MARKUP = 1.237; // PV to venta a plazos

export interface CorridaRow {
  mes: number;
  cuota: number;
  recaudoGnv: number;
  fg: number;
  diferencial: number; // de tu bolsillo
  saldo: number;
}

export interface CorridaEstimada {
  modelo: string;
  anio: number;
  pvEstimado: number;
  ventaPlazos: number;
  consumoLeq: number;
  recaudoMensual: number;
  meses: CorridaRow[];
  resumenWhatsApp: string;
}

const SOBREPRECIO_GNV = 11; // $11/LEQ — the actual CMU revenue per liter

export function generarCorridaEstimada(
  modelo: string,
  anio: number,
  pvEstimado: number,
  consumoLeqMes: number,
  _precioGnvLeq?: number, // ignored — we use sobreprecio
): CorridaEstimada {
  const ventaPlazos = Math.round(pvEstimado * MARKUP);
  const recaudoMensual = Math.round(consumoLeqMes * SOBREPRECIO_GNV);
  
  // Build amortization with anticipo
  const capitalOriginal = Math.round(ventaPlazos / PLAZO);
  const meses: CorridaRow[] = [];
  let saldo = ventaPlazos;

  // Mes 1-2: cuota original
  for (let m = 1; m <= 2; m++) {
    const interes = Math.round(saldo * TASA_MENSUAL);
    const capital = capitalOriginal;
    const cuota = capital + interes;
    saldo = Math.max(0, saldo - capital);
    
    if (m === MES_ANTICIPO) {
      saldo = Math.max(0, saldo - ANTICIPO);
    }

    const diferencial = cuota - recaudoMensual + FONDO_MENSUAL;
    meses.push({
      mes: m,
      cuota,
      recaudoGnv: recaudoMensual,
      fg: FONDO_MENSUAL,
      diferencial,
      saldo: Math.round(saldo),
    });
  }

  // Mes 3-36: recalculate with reduced saldo
  const remainingMonths = PLAZO - 2;
  const newCapital = Math.round(saldo / remainingMonths);

  for (let m = 3; m <= PLAZO; m++) {
    const interes = Math.round(saldo * TASA_MENSUAL);
    const capital = m === PLAZO ? saldo : newCapital;
    const cuota = capital + interes;
    saldo = Math.max(0, saldo - capital);

    const diferencial = cuota - recaudoMensual + FONDO_MENSUAL;
    meses.push({
      mes: m,
      cuota,
      recaudoGnv: recaudoMensual,
      fg: FONDO_MENSUAL,
      diferencial,
      saldo: Math.round(saldo),
    });
  }

  // Build WhatsApp summary — key months only
  const m1 = meses[0];
  const m3 = meses[2];
  const m12 = meses[11];
  const m24 = meses[23];
  const m36 = meses[35];

  const fmtD = (d: number) => d > 0 ? `$${d.toLocaleString()}` : `−$${Math.abs(d).toLocaleString()} (GNV cubre todo)`;
  const fmtM = (n: number) => `$${n.toLocaleString()}`;

  const resumenWhatsApp = [
    `*${modelo} ${anio}* — Corrida estimada`,
    `PV: ~${fmtM(pvEstimado)} | Tu consumo: ${consumoLeqMes} LEQ/mes`,
    ``,
    `*Antes de tu aportación ($50k):*`,
    `Mes 1: cuota ${fmtM(m1.cuota)} − GNV ${fmtM(m1.recaudoGnv)} + FG $334`,
    `→ De tu bolsillo: *${fmtD(m1.diferencial)}*`,
    ``,
    `*Después de tu aportación (mes 3+):*`,
    `Mes 3: cuota ${fmtM(m3.cuota)} − GNV ${fmtM(m3.recaudoGnv)} + FG $334`,
    `→ De tu bolsillo: *${fmtD(m3.diferencial)}*`,
    ``,
    `Mes 12: *${fmtD(m12.diferencial)}*`,
    `Mes 24: *${fmtD(m24.diferencial)}*`,
    `Mes 36: *${fmtD(m36.diferencial)}*`,
    ``,
    `La cuota baja cada mes. Después de dar tus $50k de la venta de tu taxi actual, el pago se reduce significativamente.`,
    ``,
    `_Estimación basada en precios de mercado. La corrida definitiva se genera al asignarte un vehículo._`,
  ].join("\n");

  return {
    modelo,
    anio,
    pvEstimado,
    ventaPlazos,
    consumoLeq: consumoLeqMes,
    recaudoMensual,
    meses,
    resumenWhatsApp,
  };
}

// Available models for prospect selection (curated, not full catalog)
export const MODELOS_PROSPECTO = [
  { marca: "Nissan", modelo: "March Sense", anios: [2022, 2023] },
  { marca: "Nissan", modelo: "March Advance", anios: [2022, 2023] },
  { marca: "Chevrolet", modelo: "Aveo", anios: [2022, 2023] },
  { marca: "Hyundai", modelo: "i10", anios: [2022] },
  { marca: "Renault", modelo: "Kwid", anios: [2024] },
];

export function getModelosDisponiblesText(): string {
  return MODELOS_PROSPECTO.map(m => 
    `• *${m.marca} ${m.modelo}* (${m.anios.join(", ")})`
  ).join("\n");
}
