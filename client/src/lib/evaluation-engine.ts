/**
 * CMU Purchase Decision Engine — Client-Side
 * 
 * Ported from server/evaluation-engine.ts for frontend-only operation.
 * 
 * Financial model from Ficha Programa CMU v8:
 * - Vehicle purchased from insurer at (insurerPrice + repairEstimate)
 * - Sold to driver at "Precio Venta a Plazos" = CMU × PLAZOS_MARKUP
 * - Driver pays monthly installments over 36 months
 * - Anticipo a Capital of $50,000 at month 2
 * - GNV revenue of $4,400/month — informational
 * - Fondo de Garantía: $8,000 initial + $334/month — informational
 * 
 * Calibrated test cases:
 *   March Sense 2021: CMU $195k, compra $123k, rep $10k → BUENO
 *   March Advance 2021: CMU $224k, compra $123k, rep $15k → BUENO
 *   Aveo 2022: CMU $200k, compra $100k, rep $25k → ÓPTIMO
 */

import type {
  EvaluationInput,
  EvaluationResult,
  CashFlowEntry,
  SensitivityPoint,
} from "@shared/schema";

// ===== Financial Constants =====
const ANNUAL_RATE = 0.299;
const TERM_MONTHS = 36;
const ANTICIPO_CAPITAL = 50000;
const ANTICIPO_MONTH = 2;
const GNV_REVENUE = 4400; // 400 LEQ × $11/LEQ
const PLAZOS_MARKUP = 1.237;

// ===== Decision Thresholds (configurable without touching code) =====
export type Thresholds = {
  optimoMarginMin: number;
  optimoTirMin: number;   // TIR annual as decimal (1.45 = 145%)
  buenoMarginMin: number;
  buenoTirMin: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  optimoMarginMin: 55000,
  optimoTirMin: 1.45,
  buenoMarginMin: 40000,
  buenoTirMin: 0.80,
};

// Mutable active thresholds — can be updated at runtime
let activeThresholds: Thresholds = { ...DEFAULT_THRESHOLDS };

export function getThresholds(): Thresholds {
  return { ...activeThresholds };
}

export function setThresholds(t: Partial<Thresholds>) {
  activeThresholds = { ...activeThresholds, ...t };
}

export function resetThresholds() {
  activeThresholds = { ...DEFAULT_THRESHOLDS };
}

// ===== Cash Flow Model =====
function buildCashFlowSchedule(cmu: number): { cashFlows: CashFlowEntry[]; ventaPlazos: number; monthlyPayment: number } {
  const ventaPlazos = Math.round(cmu * PLAZOS_MARKUP);
  const monthlyPayment = Math.round(ventaPlazos / TERM_MONTHS);
  let balance = ventaPlazos;
  const cashFlows: CashFlowEntry[] = [];

  for (let month = 1; month <= TERM_MONTHS; month++) {
    cashFlows.push({
      month,
      balance: Math.round(balance),
      vehiclePayment: monthlyPayment,
      gnvRevenue: GNV_REVENUE,
      netCashFlow: monthlyPayment,
    });
    balance -= monthlyPayment;
    if (month === ANTICIPO_MONTH) {
      balance -= ANTICIPO_CAPITAL;
      if (balance < 0) balance = 0;
    }
  }

  return { cashFlows, ventaPlazos, monthlyPayment };
}

// ===== IRR Calculation (Newton-Raphson) =====
function calculateIRR(cashFlows: number[], periods: number[]): number {
  let rate = 0.05;

  for (let iter = 0; iter < 300; iter++) {
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

  const annualIRR = Math.pow(1 + rate, 12) - 1;
  return annualIRR;
}

// ===== Classification =====
function classify(
  margin: number,
  tir: number,
  moic: number,
  purchasePct: number,
  totalCost: number,
  cmu: number,
  modelData: { brand: string; model: string; variant: string | null; slug: string },
  thresholds: Thresholds,
  year: number
): { decision: "COMPRAR" | "DUDOSO" | "NO COMPRAR"; decisionLevel: "optimo" | "bueno" | "descartar"; explanation: string } {
  const displayName = modelData.variant
    ? `${modelData.model} ${modelData.variant}`
    : modelData.model;

  const pctStr = `${Math.round(purchasePct * 100)}%`;
  const marginStr = `$${Math.round(margin / 1000)}k`;
  const tirStr = `${Math.round(tir * 100)}%`;
  const moicStr = `${moic.toFixed(1)}x`;

  if (margin >= thresholds.optimoMarginMin && tir >= thresholds.optimoTirMin) {
    return {
      decision: "COMPRAR",
      decisionLevel: "optimo",
      explanation: `Compra al ${pctStr} del CMU, margen ${marginStr}, TIR ${tirStr}, MOIC ${moicStr} → rango ÓPTIMO para ${displayName} ${year}.`,
    };
  }

  if (margin >= thresholds.buenoMarginMin && tir >= thresholds.buenoTirMin) {
    return {
      decision: "COMPRAR",
      decisionLevel: "bueno",
      explanation: `Compra al ${pctStr} del CMU, margen ${marginStr}, TIR ${tirStr}, MOIC ${moicStr} → rango BUENO para ${displayName} ${year}.`,
    };
  }

  const issues: string[] = [];
  if (margin < thresholds.buenoMarginMin) issues.push(`margen bajo (${marginStr})`);
  if (tir < thresholds.buenoTirMin) issues.push(`TIR baja (${tirStr})`);

  const isCloseToGood =
    margin >= thresholds.buenoMarginMin * 0.85 &&
    tir >= thresholds.buenoTirMin * 0.85;

  if (isCloseToGood) {
    return {
      decision: "DUDOSO",
      decisionLevel: "descartar",
      explanation: `Compra al ${pctStr} del CMU, margen ${marginStr}, TIR ${tirStr}, MOIC ${moicStr} → en el límite. ${issues.join(", ")}. Revisar con cuidado.`,
    };
  }

  return {
    decision: "NO COMPRAR",
    decisionLevel: "descartar",
    explanation: `Compra al ${pctStr} del CMU, margen ${marginStr}, TIR ${tirStr}, MOIC ${moicStr} → fuera de rango. ${issues.join(", ")}. Sugerido NO COMPRAR.`,
  };
}

// ===== Sensitivity =====
function buildSensitivity(
  input: EvaluationInput,
  modelData: { brand: string; model: string; variant: string | null; slug: string; purchaseBenchmarkPct: number },
  thresholds: Thresholds
): SensitivityPoint[] {
  const deltas = [-10000, -5000, 5000, 10000];
  return deltas.map((delta) => {
    const newRepair = Math.max(0, input.repairEstimate + delta);
    const newTotalCost = input.insurerPrice + newRepair;
    const newMargin = input.cmu - newTotalCost;
    const newPurchasePct = newTotalCost / input.cmu;

    const { cashFlows: schedule } = buildCashFlowSchedule(input.cmu);
    const irrFlows: number[] = [-newTotalCost];
    const irrPeriods: number[] = [0];
    let totalIn = 0;
    for (const cf of schedule) {
      irrFlows.push(cf.vehiclePayment);
      irrPeriods.push(cf.month);
      totalIn += cf.vehiclePayment;
    }
    irrFlows.push(ANTICIPO_CAPITAL);
    irrPeriods.push(ANTICIPO_MONTH);
    totalIn += ANTICIPO_CAPITAL;

    const newTir = calculateIRR(irrFlows, irrPeriods);
    const newMoic = totalIn / newTotalCost;

    const { decision, decisionLevel } = classify(
      newMargin, newTir, newMoic, newPurchasePct, newTotalCost, input.cmu,
      modelData, thresholds, input.year
    );

    return {
      repairDelta: delta,
      newRepair,
      newTotalCost,
      newMargin,
      newDecision: decision,
      newDecisionLevel: decisionLevel,
    };
  });
}

// ===== Main Evaluation Function =====
export function evaluateOpportunity(
  input: EvaluationInput,
  modelData: { brand: string; model: string; variant: string | null; slug: string; purchaseBenchmarkPct: number }
): EvaluationResult {
  const { cmu, insurerPrice, repairEstimate, city } = input;

  const totalCost = insurerPrice + repairEstimate;
  const purchasePct = totalCost / cmu;
  const margin = cmu - totalCost;

  const { cashFlows: schedule, ventaPlazos, monthlyPayment } = buildCashFlowSchedule(cmu);

  const irrFlows: number[] = [-totalCost];
  const irrPeriods: number[] = [0];
  let totalInflows = 0;

  for (const cf of schedule) {
    irrFlows.push(cf.vehiclePayment);
    irrPeriods.push(cf.month);
    totalInflows += cf.vehiclePayment;
  }

  irrFlows.push(ANTICIPO_CAPITAL);
  irrPeriods.push(ANTICIPO_MONTH);
  totalInflows += ANTICIPO_CAPITAL;

  const tirAnnual = calculateIRR(irrFlows, irrPeriods);
  const moic = totalInflows / totalCost;

  const thresholds = activeThresholds;
  const { decision, decisionLevel, explanation } = classify(
    margin, tirAnnual, moic, purchasePct, totalCost, cmu,
    modelData, thresholds, input.year
  );

  const sensitivity = buildSensitivity(input, modelData, thresholds);

  return {
    model: modelData.model,
    brand: modelData.brand,
    variant: modelData.variant,
    year: input.year,
    city: city || null,
    cmu,
    insurerPrice,
    repairEstimate,
    totalCost,
    purchasePct,
    margin,
    tirAnnual,
    moic,
    ventaPlazos,
    monthlyPayment,
    decision,
    decisionLevel,
    explanation,
    totalInflows,
    totalOutflows: totalCost,
    cashFlows: schedule,
    sensitivity,
    purchaseBenchmarkPct: modelData.purchaseBenchmarkPct,
  };
}
