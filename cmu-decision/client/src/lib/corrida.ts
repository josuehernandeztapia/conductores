/**
 * corrida.ts — German amortization calculator for CMU prospect flow.
 *
 * German (constant-capital) amortization:
 *   - Capital payment = PV / 36  (fixed every month)
 *   - Interest = saldo inicial del mes × tasa mensual  (decreasing)
 *   - Cuota = capital + interés  (decreasing each month)
 *
 * GNV covers a fixed amount each month (consumoLEQ × SOBREPRECIO_GNV).
 * deTuBolsillo = max(0, cuota − gnvCubre) + fgMensual (while fg acumulado < FG_TECHO)
 */

// ─── Constants ───────────────────────────────────────────────────────────────

export const TASA_ANUAL = 0.299;
export const SOBREPRECIO_GNV = 11; // pesos per LEQ
export const PLAZO = 36; // months
export const FG_INICIAL = 8_000; // one-time initial deposit (informational)
export const FG_MENSUAL = 334; // added to bolsillo each active month
export const FG_TECHO = 20_000; // stop accumulating FG once acumulado ≥ techo

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CorridaRow {
  mes: number;
  /** Constant capital amortization = PV / 36 */
  capital: number;
  /** Interest for the month = saldo inicial × tasa mensual */
  interes: number;
  /** Total installment = capital + interes */
  cuota: number;
  /** GNV revenue credited against the cuota = consumoLEQ × SOBREPRECIO_GNV */
  gnvCubre: number;
  /** Amount taxista actually pays from pocket = max(0, cuota - gnvCubre) + fgMensual (while < techo) */
  deTuBolsillo: number;
  /** Remaining principal after this payment */
  saldoFinal: number;
}

export interface CorridaResult {
  rows: CorridaRow[];
  /** Sum of all monthly cuotas (total cost at term) */
  totalPlazos: number;
  /** First month where gnvCubre >= cuota (0 if never) */
  mesGnvCubre100: number;
  /** Vehicle sale price used for the calculation */
  pvCMU: number;
  /** Human-readable kit label */
  kitLabel: string;
}

// ─── Main function ────────────────────────────────────────────────────────────

export function calcularCorrida(params: {
  pvCMU: number;
  consumoLEQ: number;
  kitNuevo: boolean;
  tasaAnual?: number;
  plazoMeses?: number;
}): CorridaResult {
  const {
    pvCMU,
    consumoLEQ,
    kitNuevo,
    tasaAnual = TASA_ANUAL,
    plazoMeses = PLAZO,
  } = params;

  const tasaMensual = tasaAnual / 12;
  const capitalFijo = pvCMU / plazoMeses;
  const gnvCubreMensual = consumoLEQ * SOBREPRECIO_GNV;

  const rows: CorridaRow[] = [];
  let saldo = pvCMU;
  let fgAcumulado = 0; // tracks how much FG has been paid (excluding FG_INICIAL)
  let mesGnvCubre100 = 0;
  let totalPlazos = 0;

  for (let mes = 1; mes <= plazoMeses; mes++) {
    const saldoInicial = saldo;
    const interes = round2(saldoInicial * tasaMensual);
    const capital = round2(capitalFijo);
    const cuota = round2(capital + interes);

    // GNV credit: constant every month
    const gnvCubre = round2(gnvCubreMensual);

    // FG monthly: apply while cumulative FG paid is still below the ceiling
    // (FG_INICIAL is the sign-up deposit — not included in the monthly running total here)
    const fgAunActivo = fgAcumulado < FG_TECHO;
    const fgEsMes = fgAunActivo ? FG_MENSUAL : 0;
    if (fgAunActivo) {
      fgAcumulado = Math.min(fgAcumulado + FG_MENSUAL, FG_TECHO);
    }

    const bolsilloBase = round2(Math.max(0, cuota - gnvCubre));
    const deTuBolsillo = round2(bolsilloBase + fgEsMes);

    const saldoFinal = round2(saldo - capital);
    saldo = saldoFinal;

    totalPlazos += cuota;

    if (mesGnvCubre100 === 0 && gnvCubre >= cuota) {
      mesGnvCubre100 = mes;
    }

    rows.push({
      mes,
      capital,
      interes,
      cuota,
      gnvCubre,
      deTuBolsillo,
      saldoFinal: Math.max(0, saldoFinal),
    });
  }

  return {
    rows,
    totalPlazos: round2(totalPlazos),
    mesGnvCubre100,
    pvCMU,
    kitLabel: kitNuevo ? "Kit nuevo ($9,400)" : "Reusar tanque",
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Format a number as MXN currency string, e.g. $12,345.67 */
export function formatMXN(n: number, decimals = 0): string {
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}
