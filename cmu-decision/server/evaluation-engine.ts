/**
 * CMU Purchase Decision Engine v2 — Client-Side
 *
 * Financial model from Ficha Programa CMU v8:
 * - Vehicle purchased from insurer at (insurerPrice + repairEstimate + kitGnv)
 * - Sold to driver at "Precio Venta a Plazos" = SUM of 36 cuotas (German amortization — constant principal)
 * - Amortization: capital constante + interés decreciente sobre saldo
 * - Anticipo a Capital: $50,000 at week 8 (month 2)
 * - GNV revenue: $4,400/month (400 LEQ × $11/LEQ) — informational
 * - Fondo de Garantía: $8,000 initial + $334/month, cap $20,000
 * - Float Amex: 50 days of credit (shifts real disbursement ~1.67 months)
 *
 * NO markup. Precio venta a plazos is CALCULATED from amortization schedule.
 *
 * Kit GNV:
 *   Con tanque: $18,000 — precio contado = CMU
 *   Sin tanque: $27,400 — precio contado = CMU + $9,400
 */

import type {
  EvaluationInput,
  EvaluationResult,
  AmortizationRow,
  SensitivityPoint,
} from "@shared/schema";

// ===== Program Constants (NOT assumptions — these are CMU program parameters) =====
const ANNUAL_RATE = 0.299;
const MONTHLY_RATE = ANNUAL_RATE / 12; // 2.4917%
const TERM_MONTHS = 36;
const ANTICIPO_CAPITAL = 50000;
const ANTICIPO_MONTH = 2; // Week 8 ≈ month 2
// GNV_REVENUE is now passed as parameter from fuel_prices DB
// Default fallback only used if not provided
const GNV_REVENUE_DEFAULT = 4400;
const FONDO_INICIAL = 8000;
const FONDO_MENSUAL = 334;
const FONDO_TECHO = 20000;
const FLOAT_AMEX_DAYS = 50; // Amex pays insurer price only
const DIAS_REPARACION = 15; // days to repair vehicle
const DIAS_COLOCACION = 10; // days to place with taxista
const DIAS_MUERTOS = DIAS_REPARACION + DIAS_COLOCACION; // 25 days before first cuota
const KIT_CON_TANQUE = 18000;
const KIT_SIN_TANQUE = 27400;
const PLUS_SIN_TANQUE = 9400; // CMU increases when sin tanque

// ===== Amortization: German System (capital constante + interés decreciente) =====
function buildAmortizationSchedule(precioContado: number, gnvRevenue: number = GNV_REVENUE_DEFAULT): AmortizationRow[] {
  const capitalMensual = Math.round(precioContado / TERM_MONTHS);
  const rows: AmortizationRow[] = [];
  let saldo = precioContado;
  let fondoAcumulado = FONDO_INICIAL;

  for (let month = 1; month <= TERM_MONTHS; month++) {
    const interes = Math.round(saldo * MONTHLY_RATE);
    const capital = month === TERM_MONTHS ? saldo : capitalMensual;
    const cuota = capital + interes;
    const saldoFinal = Math.max(0, saldo - capital);

    fondoAcumulado = Math.min(FONDO_TECHO, fondoAcumulado + FONDO_MENSUAL);

    rows.push({
      month,
      saldoInicial: Math.round(saldo),
      capital,
      interes,
      cuota,
      saldoFinal: Math.round(saldoFinal),
      gnvRevenue,
      depositoTransferencia: cuota - gnvRevenue,
      fondoGarantia: Math.round(fondoAcumulado),
    });

    saldo = saldoFinal;
  }

  return rows;
}

// Build amortization schedule WITH anticipo at month 2
function buildAmortizationWithAnticipo(precioContado: number, gnvRevenue: number = GNV_REVENUE_DEFAULT): AmortizationRow[] {
  const capitalMensualOriginal = Math.round(precioContado / TERM_MONTHS);
  const rows: AmortizationRow[] = [];
  let saldo = precioContado;
  let fondoAcumulado = FONDO_INICIAL;

  // Months 1-2: original schedule
  for (let month = 1; month <= 2; month++) {
    const interes = Math.round(saldo * MONTHLY_RATE);
    const capital = capitalMensualOriginal;
    const cuota = capital + interes;
    saldo = Math.max(0, saldo - capital);

    if (month === ANTICIPO_MONTH) {
      saldo = Math.max(0, saldo - ANTICIPO_CAPITAL);
    }

    fondoAcumulado = Math.min(FONDO_TECHO, fondoAcumulado + FONDO_MENSUAL);

    rows.push({
      month,
      saldoInicial: Math.round(saldo + capital + (month === ANTICIPO_MONTH ? ANTICIPO_CAPITAL : 0)),
      capital: month === ANTICIPO_MONTH ? capital + ANTICIPO_CAPITAL : capital,
      interes,
      cuota: month === ANTICIPO_MONTH ? cuota + ANTICIPO_CAPITAL : cuota,
      saldoFinal: Math.round(saldo),
      gnvRevenue,
      depositoTransferencia: cuota - gnvRevenue,
      fondoGarantia: Math.round(fondoAcumulado),
    });
  }

  // Months 3-36: recalculate with new saldo
  const remainingMonths = TERM_MONTHS - 2; // 34
  const newCapitalMensual = Math.round(saldo / remainingMonths);

  for (let month = 3; month <= TERM_MONTHS; month++) {
    const interes = Math.round(saldo * MONTHLY_RATE);
    const capital = month === TERM_MONTHS ? saldo : newCapitalMensual;
    const cuota = capital + interes;
    saldo = Math.max(0, saldo - capital);

    fondoAcumulado = Math.min(FONDO_TECHO, fondoAcumulado + FONDO_MENSUAL);

    rows.push({
      month,
      saldoInicial: Math.round(saldo + capital),
      capital,
      interes,
      cuota,
      saldoFinal: Math.round(saldo),
      gnvRevenue,
      depositoTransferencia: cuota - gnvRevenue,
      fondoGarantia: Math.round(fondoAcumulado),
    });
  }

  return rows;
}

// ===== IRR Calculation (Newton-Raphson) =====
function calculateIRR(cashFlows: number[], periods: number[]): number {
  let rate = 0.03; // initial guess (monthly)

  for (let iter = 0; iter < 500; iter++) {
    let npv = 0;
    let dnpv = 0;

    for (let i = 0; i < cashFlows.length; i++) {
      const t = periods[i];
      const discountFactor = Math.pow(1 + rate, t);
      npv += cashFlows[i] / discountFactor;
      dnpv -= (t * cashFlows[i]) / (discountFactor * (1 + rate));
    }

    if (Math.abs(npv) < 0.01) break;
    if (Math.abs(dnpv) < 1e-10) break;

    rate = rate - npv / dnpv;
    if (rate < -0.99) rate = -0.5;
    if (rate > 10) rate = 5;
  }

  // Annualize from monthly
  const annualIRR = Math.pow(1 + rate, 12) - 1;
  return annualIRR;
}

// ===== TIR 1: Base (piso mínimo — todo de golpe día 0, cuotas desde mes 1) =====
// Escenario pesimista: como si pagaras todo en efectivo y cobraras inmediatamente
function calcTirBase(totalCost: number, schedule: AmortizationRow[]): number {
  const flows: number[] = [-totalCost];
  const periods: number[] = [0];

  for (const row of schedule) {
    flows.push(row.cuota);
    periods.push(row.month);
  }

  return calculateIRR(flows, periods);
}

// ===== TIR 2: Operativa (tiempos reales, SIN anticipo) =====
// Día 0:  -reparación -kit GNV     (efectivo/transferencia)
// Día 25: primera cuota entra      (25 días muertos: 15 rep + 10 colocación)
// Día 50: -precio aseguradora      (pagas Amex — SOLO la aseguradora)
// Cuotas mensuales desde día 25
function calcTirOperativa(
  insurerPrice: number,
  repairEstimate: number,
  kitGnv: number,
  schedule: AmortizationRow[]
): number {
  const efectivoInmediato = repairEstimate + kitGnv; // día 0 en efectivo
  const amexPago = insurerPrice; // día 50 pagas Amex
  const diasMuertosEnMeses = DIAS_MUERTOS / 30; // ~0.833 meses
  const amexEnMeses = FLOAT_AMEX_DAYS / 30; // ~1.667 meses

  const flows: number[] = [];
  const periods: number[] = [];

  // Desembolso 1: rep + kit en día 0 (efectivo)
  flows.push(-efectivoInmediato);
  periods.push(0);

  // Desembolso 2: aseguradora en día 50 (Amex)
  flows.push(-amexPago);
  periods.push(amexEnMeses);

  // Cuotas: empiezan en día 25 (después de reparación + colocación)
  // Mes 1 del crédito = día 25, mes 2 = día 55, etc.
  for (const row of schedule) {
    flows.push(row.cuota);
    periods.push(diasMuertosEnMeses + row.month); // offset by dead days
  }

  return calculateIRR(flows, periods);
}

// ===== TIR 3: Completa (tiempos reales + anticipo $50k) =====
// Igual que operativa pero usa schedule con anticipo (cuotas recalculadas mes 3-36)
function calcTirCompleta(
  insurerPrice: number,
  repairEstimate: number,
  kitGnv: number,
  scheduleAnticipo: AmortizationRow[]
): number {
  const efectivoInmediato = repairEstimate + kitGnv;
  const amexPago = insurerPrice;
  const diasMuertosEnMeses = DIAS_MUERTOS / 30;
  const amexEnMeses = FLOAT_AMEX_DAYS / 30;

  const flows: number[] = [];
  const periods: number[] = [];

  // Desembolso 1: rep + kit en día 0
  flows.push(-efectivoInmediato);
  periods.push(0);

  // Desembolso 2: aseguradora en día 50
  flows.push(-amexPago);
  periods.push(amexEnMeses);

  // Cuotas con anticipo: empiezan día 25
  // (mes 2 ya incluye el anticipo de $50k en el schedule)
  for (const row of scheduleAnticipo) {
    flows.push(row.cuota);
    periods.push(diasMuertosEnMeses + row.month);
  }

  return calculateIRR(flows, periods);
}

// ===== v11: Guardrail Types =====
export type Guardrail = {
  label: string;
  value: string;
  threshold: string;
  passed: boolean;
};

export type RiesgoCliente = {
  diferencialM1: number;
  diferencialM3: number;
  difPctGasolina: number; // diferencial as % of gastoGasolina
  nivel: "BAJO" | "MEDIO" | "ALTO";
  mesGnvCubre: number | null;
};

// ===== v11: Find minimum viable PV (bisection method) =====
// Find minimum PV that satisfies TIR Proyecto >= 29.9% AND %CMU <= 82%
function findPVMinimo(
  insurerPrice: number,
  repairEstimate: number,
  kitGnv: number,
  gnvRevenue: number,
): number {
  const ct = insurerPrice + repairEstimate + kitGnv;
  let lo = ct;
  let hi = ct * 2.5;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const schedule = buildAmortizationSchedule(mid, gnvRevenue);
    const tir = calcTirBase(ct, schedule);
    const pctCMU = (ct / mid) * 100;
    if (tir >= 0.299 && pctCMU <= 82) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return Math.round(hi / 1000) * 1000;
}

// ===== v11: Build 8 binary guardrails =====
function buildGuardrails(
  tirBase: number,
  tirCompleta: number,
  costoPctCmu: number,
  moic: number,
  pv: number,
  pvMinimo: number,
  repairEstimate: number,
  insurerPrice: number,
  diferencialM3: number,
  gastoGasolina: number,
  totalCost: number,
  capitalCMU: number,
): Guardrail[] {
  return [
    {
      label: "TIR Proyecto",
      value: `${(tirBase * 100).toFixed(1)}%`,
      threshold: "≥29.9%",
      passed: tirBase >= 0.299,
    },
    {
      label: "TIR c/Amex",
      value: `${(tirCompleta * 100).toFixed(1)}%`,
      threshold: "≥60%",
      passed: tirCompleta >= 0.60,
    },
    {
      label: "%CMU",
      value: `${(costoPctCmu * 100).toFixed(1)}%`,
      threshold: "≤82%",
      passed: costoPctCmu * 100 <= 82,
    },
    {
      label: "MOIC",
      value: `${moic.toFixed(2)}x`,
      threshold: "≥1.4x",
      passed: moic >= 1.4,
    },
    {
      label: "PV ≥ mínimo",
      value: `$${pv.toLocaleString()}`,
      threshold: `mín $${pvMinimo.toLocaleString()}`,
      passed: pv >= pvMinimo,
    },
    {
      label: "Rep/Compra",
      value: `${insurerPrice > 0 ? (repairEstimate / insurerPrice * 100).toFixed(0) : "0"}%`,
      threshold: "≤25%",
      passed: insurerPrice > 0 ? (repairEstimate / insurerPrice * 100) <= 25 : true,
    },
    {
      label: "Dif m3 vs gas",
      value: `$${diferencialM3.toLocaleString()}`,
      threshold: `≤$${gastoGasolina.toLocaleString()}`,
      passed: diferencialM3 <= gastoGasolina,
    },
  ];
}

// ===== v11: Build risk assessment =====
function buildRiesgoCliente(
  cuotaM1: number,
  cuotaM3: number,
  gnvRevenue: number,
  gastoGasolina: number,
  mesGnvCubre: number | null,
): RiesgoCliente {
  const diferencialM1 = Math.max(0, cuotaM1 - gnvRevenue);
  const diferencialM3 = Math.max(0, cuotaM3 - gnvRevenue);
  const difPctGasolina = gastoGasolina > 0 ? diferencialM3 / gastoGasolina : 0;

  let nivel: "BAJO" | "MEDIO" | "ALTO";
  if (difPctGasolina <= 0.5) {
    nivel = "BAJO";
  } else if (difPctGasolina <= 0.8) {
    nivel = "MEDIO";
  } else {
    nivel = "ALTO";
  }

  return { diferencialM1, diferencialM3, difPctGasolina, nivel, mesGnvCubre };
}

// ===== v11: Guardrails-based classification =====
function classifyV11(
  guardrails: Guardrail[],
  modelData: { brand: string; model: string; variant: string | null },
  year: number,
): { decision: "COMPRAR" | "VIABLE" | "NO COMPRAR"; decisionLevel: "comprar" | "viable" | "descartar"; explanation: string } {
  const displayName = modelData.variant
    ? `${modelData.model} ${modelData.variant}`
    : modelData.model;

  const passed = guardrails.filter(g => g.passed).length;
  const failed = guardrails.filter(g => !g.passed);
  const failedNames = failed.map(g => `${g.label} (${g.value} vs ${g.threshold})`);

  if (passed === 7) {
    return {
      decision: "COMPRAR",
      decisionLevel: "comprar",
      explanation: `7/7 filtros OK → COMPRAR ${displayName} ${year}. Todos los guardrails del programa satisfechos.`,
    };
  }

  if (passed >= 5) {
    return {
      decision: "VIABLE",
      decisionLevel: "viable",
      explanation: `${passed}/7 filtros → VIABLE ${displayName} ${year}. Falla: ${failedNames.join(", ")}. Revisar con cuidado.`,
    };
  }

  return {
    decision: "NO COMPRAR",
    decisionLevel: "descartar",
    explanation: `${passed}/7 filtros → NO COMPRAR ${displayName} ${year}. Fallan: ${failedNames.join(", ")}.`,
  };
}

// ===== Classification (legacy — kept for backward compat in sensitivity) =====
function classify(
  tirBase: number,
  margin: number,
  modelData: { brand: string; model: string; variant: string | null },
  year: number,
  costoPctCmu: number,
  tirOperativa: number,
  tirCompleta: number,
  moic: number,
): { decision: "COMPRAR" | "VIABLE" | "NO COMPRAR"; decisionLevel: "comprar" | "viable" | "descartar"; explanation: string } {
  const displayName = modelData.variant
    ? `${modelData.model} ${modelData.variant}`
    : modelData.model;

  const pctStr = `${Math.round(costoPctCmu * 100)}%`;
  const marginStr = `$${Math.round(margin / 1000)}k`;
  const tirBaseStr = `${Math.round(tirBase * 100)}%`;
  const tirOpStr = `${Math.round(tirOperativa * 100)}%`;
  const tirCompStr = `${Math.round(tirCompleta * 100)}%`;
  const moicStr = `${moic.toFixed(1)}x`;

  // Hard stops
  if (tirBase < ANNUAL_RATE) {
    return {
      decision: "NO COMPRAR",
      decisionLevel: "descartar",
      explanation: `TIR Base ${tirBaseStr} < tasa programa 29.9%. Costo al ${pctStr} del CMU, margen ${marginStr}. La operación no cubre el costo del capital para ${displayName} ${year}.`,
    };
  }

  if (margin < 15000) {
    return {
      decision: "NO COMPRAR",
      decisionLevel: "descartar",
      explanation: `Margen ${marginStr} < $15k mínimo. TIR Base ${tirBaseStr}, costo al ${pctStr} del CMU. Margen insuficiente para ${displayName} ${year}.`,
    };
  }

  // COMPRAR: TIR Base >= 29.9% AND Margen >= $40k
  if (tirBase >= ANNUAL_RATE && margin >= 40000) {
    return {
      decision: "COMPRAR",
      decisionLevel: "comprar",
      explanation: `Costo al ${pctStr} del CMU, margen ${marginStr}, TIR Base ${tirBaseStr}, TIR Operativa ${tirOpStr}, TIR Completa ${tirCompStr}, MOIC ${moicStr} → COMPRAR ${displayName} ${year}.`,
    };
  }

  // VIABLE: TIR Base >= 29.9% AND Margen >= $25k
  if (tirBase >= ANNUAL_RATE && margin >= 25000) {
    return {
      decision: "VIABLE",
      decisionLevel: "viable",
      explanation: `Costo al ${pctStr} del CMU, margen ${marginStr}, TIR Base ${tirBaseStr}, TIR Operativa ${tirOpStr}, TIR Completa ${tirCompStr}, MOIC ${moicStr} → VIABLE para ${displayName} ${year}. Revisar con cuidado.`,
    };
  }

  // Everything else: NO COMPRAR
  const issues: string[] = [];
  if (margin < 25000) issues.push(`margen bajo (${marginStr})`);
  if (tirBase < ANNUAL_RATE) issues.push(`TIR Base insuficiente (${tirBaseStr})`);

  return {
    decision: "NO COMPRAR",
    decisionLevel: "descartar",
    explanation: `Costo al ${pctStr} del CMU, margen ${marginStr}, TIR Base ${tirBaseStr}. ${issues.join(", ")}. NO COMPRAR ${displayName} ${year}.`,
  };
}

// ===== Sensitivity =====
function buildSensitivity(
  input: EvaluationInput,
  precioContado: number,
  kitGnv: number,
  modelData: { brand: string; model: string; variant: string | null },
): SensitivityPoint[] {
  const deltas = [-10000, -5000, 5000, 10000];
  return deltas.map((delta) => {
    const newRepair = Math.max(0, input.repairEstimate + delta);
    const newTotalCost = input.insurerPrice + newRepair + kitGnv;
    const newMargin = precioContado - newTotalCost;
    const schedule = buildAmortizationSchedule(precioContado);
    const newTirBase = calcTirBase(newTotalCost, schedule);

    const { decision, decisionLevel } = classify(
      newTirBase, newMargin, modelData, input.year,
      newTotalCost / precioContado, 0, 0, 0,
    );

    return {
      repairDelta: delta,
      newRepair,
      newTotalCost,
      newMargin,
      newTirBase,
      newDecision: decision,
      newDecisionLevel: decisionLevel,
    };
  });
}

// ===== Main Evaluation Function =====
export function evaluateOpportunity(
  input: EvaluationInput,
  modelData: { brand: string; model: string; variant: string | null; slug: string; purchaseBenchmarkPct: number },
  options?: { gnvRevenue?: number; marketAvgPrice?: number | null; gastoGasolina?: number; capitalCMU?: number }
): EvaluationResult {
  const { cmu, insurerPrice, repairEstimate, conTanque, city } = input;
  const gnvRevenue = options?.gnvRevenue || GNV_REVENUE_DEFAULT;
  const marketAvgPrice = options?.marketAvgPrice || null;
  const gastoGasolina = options?.gastoGasolina ?? 7000;
  const capitalCMU = options?.capitalCMU ?? 500000;

  // Kit GNV and precio contado
  const kitGnv = conTanque ? KIT_CON_TANQUE : KIT_SIN_TANQUE;
  let precioContado = conTanque ? cmu : cmu + PLUS_SIN_TANQUE;

  // PRICE RULES:
  // 1. PV floor: if catalog price < market×0.95, bump to market×0.95
  // 2. PV cap: PV cannot exceed market average price
  // Result: PV = min(marketAvg, max(catalog, market×0.95))
  let precioCapped = false;
  let precioAjustado = false;
  let precioMaxCMU = precioContado;
  let precioOriginal = precioContado;
  if (marketAvgPrice && marketAvgPrice > 0) {
    const marketFloor = Math.round(marketAvgPrice * 0.95);
    // Floor: if catalog < 95% of market, bump up
    if (precioContado < marketFloor) {
      precioContado = marketFloor;
      precioAjustado = true;
    }
    // Cap: cannot exceed market average
    precioMaxCMU = marketAvgPrice;
    if (precioContado > marketAvgPrice) {
      precioCapped = true;
      precioContado = marketAvgPrice;
    }
  }

  // Total cost = insurer + repair + kit
  const totalCost = insurerPrice + repairEstimate + kitGnv;
  const costoPctCmu = totalCost / precioContado;
  const asegPctCmu = insurerPrice / cmu;
  const margin = precioContado - totalCost;

  // Amortization schedules (using capped price and dynamic gnvRevenue)
  const amortizacion = buildAmortizationSchedule(precioContado, gnvRevenue);
  const amortizacionConAnticipo = buildAmortizationWithAnticipo(precioContado, gnvRevenue);

  // Venta a plazos = sum of all cuotas (base schedule, no anticipo)
  const ventaPlazos = amortizacion.reduce((s, r) => s + r.cuota, 0);
  const cuotaMes1 = amortizacion[0].cuota;
  const cuotaMes36 = amortizacion[TERM_MONTHS - 1].cuota;

  // First month where GNV covers the full cuota (dynamic)
  const mesGnvCubreRow = amortizacion.find(r => r.cuota <= gnvRevenue);
  const mesGnvCubre = mesGnvCubreRow ? mesGnvCubreRow.month : null;

  // 3 TIRs
  const tirBase = calcTirBase(totalCost, amortizacion);
  const tirOperativa = calcTirOperativa(insurerPrice, repairEstimate, kitGnv, amortizacion);
  const tirCompleta = calcTirCompleta(insurerPrice, repairEstimate, kitGnv, amortizacionConAnticipo);

  // MOIC (on anticipo schedule — the real one)
  const totalInflowsAnticipo = amortizacionConAnticipo.reduce((s, r) => s + r.cuota, 0);
  const moic = totalInflowsAnticipo / totalCost;

  // v11: PV mínimo (bisection)
  const pvMinimo = findPVMinimo(insurerPrice, repairEstimate, kitGnv, gnvRevenue);

  // v11: Cuota post-anticipo mes 3
  const cuotaM3 = amortizacionConAnticipo.length >= 3 ? amortizacionConAnticipo[2].cuota : cuotaMes1;
  const diferencialM3 = Math.max(0, cuotaM3 - gnvRevenue);

  // v11: 8 Guardrails
  const guardrails = buildGuardrails(
    tirBase, tirCompleta, costoPctCmu, moic,
    precioContado, pvMinimo,
    repairEstimate, insurerPrice,
    diferencialM3, gastoGasolina,
    totalCost, capitalCMU,
  );
  const guardrailsPassed = guardrails.filter(g => g.passed).length;

  // v11: Risk assessment
  const riesgoCliente = buildRiesgoCliente(cuotaMes1, cuotaM3, gnvRevenue, gastoGasolina, mesGnvCubre);

  // v11: Payback month (first month where cumulative inflows >= totalCost)
  let paybackMonth: number | null = null;
  let cumInflows = 0;
  for (const row of amortizacionConAnticipo) {
    cumInflows += row.cuota;
    if (cumInflows >= totalCost) {
      paybackMonth = row.month;
      break;
    }
  }

  // v11: Classification based on guardrails
  const { decision, decisionLevel, explanation } = classifyV11(guardrails, modelData, input.year);

  // Sensitivity (uses legacy classify for backward compat)
  const sensitivity = buildSensitivity(input, precioContado, kitGnv, modelData);

  return {
    model: modelData.model,
    brand: modelData.brand,
    variant: modelData.variant,
    year: input.year,
    city: city || null,
    cmu,
    precioContado,
    insurerPrice,
    repairEstimate,
    kitGnv,
    conTanque,
    totalCost,
    costoPctCmu,
    asegPctCmu,
    margin,
    precioMaxCMU,
    marketAvgPrice,
    precioCapped,
    ventaPlazos,
    cuotaMes1,
    cuotaMes36,
    mesGnvCubre,
    amortizacion,
    amortizacionConAnticipo,
    tirBase,
    tirOperativa,
    tirCompleta,
    moic,
    totalInflows: totalInflowsAnticipo,
    totalOutflows: totalCost,
    decision,
    decisionLevel,
    explanation,
    sensitivity,
    // v11 new fields
    pvMinimo,
    guardrails,
    guardrailsPassed,
    riesgoCliente,
    paybackMonth,
    diferencialM3,
    gastoGasolina,
    capitalCMU,
  };
}
