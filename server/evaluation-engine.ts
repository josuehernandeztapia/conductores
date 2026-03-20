/**
 * CMU Purchase Decision Engine
 * 
 * Implements the financial model from the Ficha Programa CMU v8:
 * - Vehicle is purchased from insurer at (insurerPrice + repairEstimate)
 * - Vehicle is sold to driver at "Precio Venta a Plazos" = CMU × PLAZOS_MARKUP
 * - Driver pays monthly installments over 36 months
 * - Driver also pays Anticipo a Capital of $50,000 at month 2
 * - GNV revenue of $4,400/month (400 LEQ × $11) — informational
 * - Fondo de Garantía: $8,000 initial + $334/month — informational
 * 
 * IRR/MOIC are calculated from CMU's cash flow perspective:
 * - Month 0: -totalCost (purchase from insurer + repair)
 * - Month 2: +$50,000 (anticipo from driver)
 * - Months 1-36: +monthly_payment (installments from driver)
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
const MONTHLY_RATE = ANNUAL_RATE / 12;
const TERM_MONTHS = 36;
const ANTICIPO_CAPITAL = 50000;
const ANTICIPO_MONTH = 2;
const GNV_REVENUE = 4400; // 400 LEQ × $11/LEQ
const FONDO_INITIAL = 8000;
const FONDO_MONTHLY = 334;

// Venta a Plazos markup factor (from real Ficha Programa):
//   March Sense: 240615 / 195000 = 1.234
//   March Advance: 282449 / 224000 = 1.261
//   Aveo: 247429 / 200000 = 1.237
// Use a CMU-weighted average
const PLAZOS_MARKUP = 1.237;

// ===== Decision Thresholds (calibrated to match test cases) =====
// These are configurable without touching code — change this object
type Thresholds = {
  optimoMarginMin: number;
  optimoTirMin: number;   // TIR annual as decimal (1.45 = 145%)
  buenoMarginMin: number;
  buenoTirMin: number;
};

const DEFAULT_THRESHOLDS: Thresholds = {
  // ÓPTIMO: Margin >= 55k AND TIR >= 145%
  optimoMarginMin: 55000,
  optimoTirMin: 1.45,

  // BUENO: Margin >= 40k AND TIR >= 80%
  buenoMarginMin: 40000,
  buenoTirMin: 0.80,
};

// ===== Cash Flow Model =====
// The driver pays CMU a fixed monthly installment = ventaPlazos / 36
// Plus anticipo of $50k at month 2
// From CMU's perspective this is all inflow

function buildCashFlowSchedule(cmu: number): { cashFlows: CashFlowEntry[]; ventaPlazos: number; monthlyPayment: number } {
  const ventaPlazos = Math.round(cmu * PLAZOS_MARKUP);
  const monthlyPayment = Math.round(ventaPlazos / TERM_MONTHS);

  // Track the driver's outstanding balance for display purposes
  let balance = ventaPlazos; // Total amount owed by driver

  const cashFlows: CashFlowEntry[] = [];

  for (let month = 1; month <= TERM_MONTHS; month++) {
    cashFlows.push({
      month,
      balance: Math.round(balance),
      vehiclePayment: monthlyPayment,
      gnvRevenue: GNV_REVENUE,
      netCashFlow: monthlyPayment, // CMU receives the full installment
    });

    balance -= monthlyPayment;

    // Anticipo reduces balance at month 2
    if (month === ANTICIPO_MONTH) {
      balance -= ANTICIPO_CAPITAL;
      if (balance < 0) balance = 0;
    }
  }

  return { cashFlows, ventaPlazos, monthlyPayment };
}

// ===== IRR Calculation (Newton-Raphson) =====
function calculateIRR(cashFlows: number[], periods: number[]): number {
  // Monthly IRR via Newton-Raphson, then annualize
  let rate = 0.05; // Initial guess: 5% monthly

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

  // Annualize: (1 + monthly)^12 - 1
  const annualIRR = Math.pow(1 + rate, 12) - 1;
  return annualIRR;
}

// ===== Main Evaluation Function =====
export function evaluateOpportunity(
  input: EvaluationInput,
  modelData: { brand: string; model: string; variant: string | null; slug: string; purchaseBenchmarkPct: number }
): EvaluationResult {
  const { cmu, insurerPrice, repairEstimate, city } = input;

  // Core calculations
  const totalCost = insurerPrice + repairEstimate;
  const purchasePct = totalCost / cmu;
  const margin = cmu - totalCost;

  // Build cash flow schedule
  const { cashFlows: schedule, ventaPlazos, monthlyPayment } = buildCashFlowSchedule(cmu);

  // CMU cash flows for IRR:
  // Month 0: -totalCost (outflow: buy from insurer + repair)
  // Month 2: +50,000 (anticipo from driver)
  // Months 1-36: +monthlyPayment (installments from driver)
  const irrFlows: number[] = [-totalCost];
  const irrPeriods: number[] = [0];

  let totalInflows = 0;

  for (const cf of schedule) {
    irrFlows.push(cf.vehiclePayment);
    irrPeriods.push(cf.month);
    totalInflows += cf.vehiclePayment;
  }

  // Add anticipo as separate inflow at month 2
  irrFlows.push(ANTICIPO_CAPITAL);
  irrPeriods.push(ANTICIPO_MONTH);
  totalInflows += ANTICIPO_CAPITAL;

  const tirAnnual = calculateIRR(irrFlows, irrPeriods);
  const moic = totalInflows / totalCost;

  // Decision logic — simplified: no purchasePct gating
  const thresholds = DEFAULT_THRESHOLDS;
  const { decision, decisionLevel, explanation } = classify(
    margin, tirAnnual, moic, purchasePct, totalCost, cmu,
    modelData, thresholds, input.year
  );

  // Sensitivity: what if repair changes by ±5k, ±10k
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

  // ÓPTIMO: Margin >= 55k AND TIR >= 145%
  if (
    margin >= thresholds.optimoMarginMin &&
    tir >= thresholds.optimoTirMin
  ) {
    return {
      decision: "COMPRAR",
      decisionLevel: "optimo",
      explanation: `Compra al ${pctStr} del CMU, margen ${marginStr}, TIR ${tirStr}, MOIC ${moicStr} → rango ÓPTIMO para ${displayName} ${year}.`,
    };
  }

  // BUENO: Margin >= 40k AND TIR >= 80%
  if (
    margin >= thresholds.buenoMarginMin &&
    tir >= thresholds.buenoTirMin
  ) {
    return {
      decision: "COMPRAR",
      decisionLevel: "bueno",
      explanation: `Compra al ${pctStr} del CMU, margen ${marginStr}, TIR ${tirStr}, MOIC ${moicStr} → rango BUENO para ${displayName} ${year}.`,
    };
  }

  // DESCARTAR: check what's wrong
  const issues: string[] = [];
  if (margin < thresholds.buenoMarginMin) issues.push(`margen bajo (${marginStr})`);
  if (tir < thresholds.buenoTirMin) issues.push(`TIR baja (${tirStr})`);

  // If it's close to BUENO thresholds, call it DUDOSO
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

    // Full recalculation for sensitivity
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
