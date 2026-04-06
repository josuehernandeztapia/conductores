/**
 * Corrida Estimada — Para prospectos por WhatsApp
 * 
 * Genera corrida con amortización alemana (capital fijo, interés decreciente).
 * Anticipo $50k en mes 2 → recalcula capital fijo sobre saldo restante.
 * Usa precios pvBase de vehicles_inventory en Neon.
 */

import { neon } from "@neondatabase/serverless";

// Constants
const TASA_ANUAL = 0.299;
const TASA_M = TASA_ANUAL / 12;
const N = 36;
const ANT = 50000;
const FG_I = 8000;
const FG_M = 334;
const FG_TOP = 20000;
const SOBREPRECIO_GNV = 11; // $11/LEQ

export interface CorridaRow {
  mes: number;
  cuota: number;
  recaudoGnv: number;
  fg: number;
  diferencial: number;
  saldo: number;
}

export interface CorridaEstimada {
  modelo: string;
  anio: number;
  pvBase: number;
  consumoLeq: number;
  recaudoMensual: number;
  meses: CorridaRow[];
  mesGnvCubre: number | null;
  resumenWhatsApp: string;
}

interface VehiclePrice {
  id: number;
  marca: string;
  modelo: string;
  variante: string | null;
  anio: number;
  precio: number;
  slug: string;
}

// Cache vehicle prices (refresh every 5 min)
let cachedPrices: VehiclePrice[] = [];
let cacheTime = 0;

async function getVehiclePrices(): Promise<VehiclePrice[]> {
  if (cachedPrices.length > 0 && Date.now() - cacheTime < 300000) return cachedPrices;
  try {
    const sql = neon(process.env.DATABASE_URL!);
    const rows = await sql`
      SELECT id, marca, modelo, variante, anio, cmu_valor as precio, slug
      FROM vehicles_inventory
      WHERE status = 'disponible'
      ORDER BY orden ASC, id ASC
    `;
    cachedPrices = rows as VehiclePrice[];
    cacheTime = Date.now();
  } catch (e: any) {
    console.error("[Corrida] Error fetching prices:", e.message);
  }
  return cachedPrices;
}

function fmt(n: number): string {
  return "$" + Math.round(Math.abs(n)).toLocaleString("es-MX");
}

export function buildAmortRows(precio: number, leq: number): { rows: CorridaRow[]; recaudo: number; mesGnvCubre: number | null } {
  const recaudo = leq * SOBREPRECIO_GNV;
  let saldo = precio;
  let P = precio / N;
  const rows: CorridaRow[] = [];
  let fgAcum = FG_I;
  let mesGnvCubre: number | null = null;

  for (let m = 1; m <= N; m++) {
    const interes = saldo * TASA_M;
    const cuota = Math.round(P + interes);
    const fgA = fgAcum >= FG_TOP ? 0 : FG_M;
    fgAcum = Math.min(FG_TOP, fgAcum + fgA);
    const diferencial = Math.max(0, cuota - recaudo) + fgA;

    if (mesGnvCubre === null && cuota <= recaudo) mesGnvCubre = m;

    rows.push({ mes: m, cuota, recaudoGnv: recaudo, fg: fgA, diferencial, saldo: Math.round(saldo) });
    saldo -= P;
    if (m === 2) {
      saldo -= ANT;
      P = saldo / (N - 2);
    }
  }
  return { rows, recaudo, mesGnvCubre };
}

export function generarCorridaEstimada(
  modelo: string, anio: number, pvBase: number, consumoLeqMes: number,
  _precioGnvLeq?: number,
): CorridaEstimada {
  const { rows, recaudo, mesGnvCubre } = buildAmortRows(pvBase, consumoLeqMes);

  const m1 = rows[0];
  const m3 = rows[2];
  const mesGnvLabel = mesGnvCubre ? `Mes ${mesGnvCubre}` : "Mes 34+";

  const fmtBol = (d: number) => d <= FG_M ? "$0 (GNV cubre todo)" : fmt(d);

  const resumenWhatsApp = [
    `*${modelo} ${anio}* — ${fmt(pvBase)}`,
    `Tu consumo: ${consumoLeqMes} LEQ/mes → recaudo ${fmt(recaudo)}/mes`,
    ``,
    `*Mes 1–2* (antes de vender tu taxi):`,
    `Cuota: ${fmt(m1.cuota)} | GNV cubre: ${fmt(recaudo)}`,
    `→ De tu bolsillo: *${fmtBol(m1.diferencial)}*`,
    ``,
    `*Día 56* — Vendes tu taxi → $50,000 a capital`,
    ``,
    `*Mes 3+* (cuota recalculada):`,
    `Cuota: ${fmt(m3.cuota)} | GNV cubre: ${fmt(recaudo)}`,
    `→ De tu bolsillo: *${fmtBol(m3.diferencial)}*`,
    ``,
    `*${mesGnvLabel}:* GNV cubre tu cuota completa → *$0 de tu bolsillo*`,
    `*Mes 37:* Vehículo 100% tuyo`,
    ``,
    `_Cuota baja cada mes (amortización alemana). Números basados en tu consumo real._`,
  ].join("\n");

  return {
    modelo, anio, pvBase, consumoLeq: consumoLeqMes, recaudoMensual: recaudo,
    meses: rows, mesGnvCubre, resumenWhatsApp,
  };
}

/**
 * Generate a summary of ALL 5 available models with key numbers
 */
export async function generarResumen5Modelos(leq: number): Promise<string> {
  const vehicles = await getVehiclePrices();
  if (vehicles.length === 0) return getModelosDisponiblesText(); // fallback

  const recaudo = leq * SOBREPRECIO_GNV;
  const lines = vehicles.map(v => {
    const { rows, mesGnvCubre } = buildAmortRows(v.precio, leq);
    const m3 = rows[2];
    const bolsillo = m3.diferencial;
    const gnvLabel = mesGnvCubre ? `mes ${mesGnvCubre}` : "mes 34+";
    const name = [v.marca, v.modelo, v.variante, v.anio].filter(Boolean).join(" ");
    return `• *${name}* — ${fmt(v.precio)}\n  Cuota mes 3+: ${fmt(m3.cuota)} | Bolsillo: *${fmt(bolsillo)}/mes*\n  GNV cubre todo desde ${gnvLabel}`;
  });

  return [
    `Con ${leq} LEQ/mes, tu recaudo GNV cubre *${fmt(recaudo)}/mes* de la cuota.\n`,
    `*Vehículos disponibles:*\n`,
    ...lines,
    `\n¿Cuál te interesa? Te doy el detalle completo.`,
  ].join("\n");
}

// Available models for matching user input
export const MODELOS_PROSPECTO = [
  { marca: "Chevrolet", modelo: "Aveo", anios: [2022] },
  { marca: "Nissan", modelo: "March Sense", anios: [2021] },
  { marca: "Nissan", modelo: "March Advance", anios: [2021] },
  { marca: "Renault", modelo: "Kwid", anios: [2024] },
  { marca: "Hyundai", modelo: "i10", anios: [2022] },
];

export function getModelosDisponiblesText(): string {
  return MODELOS_PROSPECTO.map(m => 
    `• *${m.marca} ${m.modelo}* (${m.anios.join(", ")})`
  ).join("\n");
}

/**
 * Match a model from free-text user input
 */
export function matchModelFromText(text: string): { marca: string; modelo: string; anio: number } | null {
  const lower = text.toLowerCase();
  if (/march.*sense|sense/i.test(lower)) return { marca: "Nissan", modelo: "March Sense", anio: 2021 };
  if (/march.*advance|advance/i.test(lower)) return { marca: "Nissan", modelo: "March Advance", anio: 2021 };
  if (/aveo/i.test(lower)) return { marca: "Chevrolet", modelo: "Aveo", anio: 2022 };
  if (/i10|i 10|grand/i.test(lower)) return { marca: "Hyundai", modelo: "i10", anio: 2022 };
  if (/kwid/i.test(lower)) return { marca: "Renault", modelo: "Kwid", anio: 2024 };
  
  for (const m of MODELOS_PROSPECTO) {
    if (lower.includes(m.modelo.toLowerCase()) || lower.includes(m.marca.toLowerCase())) {
      return { marca: m.marca, modelo: m.modelo, anio: m.anios[0] };
    }
  }
  return null;
}

/**
 * Get pvBase for a model from Neon
 */
export async function getPvForModel(marca: string, modelo: string, anio: number): Promise<number> {
  const vehicles = await getVehiclePrices();
  const match = vehicles.find(v => 
    v.marca.toLowerCase() === marca.toLowerCase() && 
    (v.modelo.toLowerCase().includes(modelo.toLowerCase()) || modelo.toLowerCase().includes(v.modelo.toLowerCase())) &&
    v.anio === anio
  );
  if (match) return match.precio;
  
  // Fallback: try partial match
  const partial = vehicles.find(v => 
    v.modelo.toLowerCase().includes(modelo.split(" ")[0].toLowerCase())
  );
  return partial ? partial.precio : 200000;
}
