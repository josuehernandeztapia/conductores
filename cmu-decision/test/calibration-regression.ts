/**
 * calibration-regression.ts
 * Regression tests for the 3 calibration models to ensure TIR/MOIC/margin
 * calculations remain consistent after any code change.
 *
 * These are DETERMINISTIC — no LLM, no market scraping, no external calls.
 * They call evaluateOpportunity() directly with fixed inputs.
 *
 * CASES:
 *   CAL01 — March Sense 2021: 123k compra, 10k rep → TIR 93.87%, MOIC 2.02x
 *   CAL02 — March Advance 2021: 123k compra, 20k rep → TIR 81.56%, MOIC 1.89x
 *   CAL03 — Aveo 2022: 100k compra, 25k rep → TIR 101.78%, MOIC 2.09x
 *
 * Run via API: POST https://cmu-originacion.fly.dev/api/test/calibration-regression
 */

interface CalResult {
  id: string;
  name: string;
  pass: boolean;
  assertions: Array<{ ok: boolean; msg: string }>;
  actual: Record<string, any>;
  error?: string;
}

function ok(condition: boolean, msg: string): { ok: boolean; msg: string } {
  return { ok: condition, msg: condition ? `✅ ${msg}` : `❌ ${msg}` };
}

/**
 * Assert a numeric value is within tolerance of expected.
 * For TIR: ±0.5% absolute (0.005)
 * For MOIC: ±0.02x
 * For money: ±$500
 */
function near(actual: number, expected: number, tolerance: number, label: string): { ok: boolean; msg: string } {
  const diff = Math.abs(actual - expected);
  const pass = diff <= tolerance;
  return ok(pass, pass
    ? `${label}: ${actual} ≈ ${expected} (±${tolerance})`
    : `${label}: ${actual} ≠ ${expected} (diff=${diff.toFixed(4)}, tolerance=${tolerance})`
  );
}

export async function runCalibrationRegression(): Promise<{
  passed: number;
  failed: number;
  total: number;
  results: CalResult[];
}> {
  const { evaluateOpportunity } = await import("../server/evaluation-engine");
  const results: CalResult[] = [];

  // ═══════════════════════════════════════════════════════════════════════
  // Calibration snapshot — captured 2026-04-10 with current CMU prices
  // These MUST NOT change unless business rules change intentionally
  // ═══════════════════════════════════════════════════════════════════════

  const CALIBRATION = [
    {
      id: "CAL01",
      name: "March Sense 2021 — 123k compra, 10k rep",
      input: {
        modelId: 1,
        modelSlug: "nissan-march-sense",
        year: 2021,
        cmu: 223298,
        insurerPrice: 123000,
        repairEstimate: 10000,
        conTanque: true,
      },
      modelData: {
        brand: "Nissan",
        model: "March",
        variant: "Sense",
        slug: "nissan-march-sense",
        purchaseBenchmarkPct: 0.60,
      },
      expected: {
        totalCost: 151000,
        margin: 72298,
        costoPctCmu: 0.6762,
        tirBase: 0.9387,
        tirOperativa: 0.9999,
        tirCompleta: 1.3347,
        moic: 2.0161,
        paybackMonth: 12,
        kitGnv: 18000,
        ventaPlazos: 326224,
        cuotaMes1: 11767,
        cuotaMes36: 6347,
        decision: "COMPRAR",
        riesgoNivel: "MEDIO",
        diferencialM1: 7367,
        diferencialM3: 4341,
      },
    },
    {
      id: "CAL02",
      name: "March Advance 2021 — 123k compra, 20k rep",
      input: {
        modelId: 3,
        modelSlug: "nissan-march-advance",
        year: 2021,
        cmu: 223298,
        insurerPrice: 123000,
        repairEstimate: 20000,
        conTanque: true,
      },
      modelData: {
        brand: "Nissan",
        model: "March",
        variant: "Advance",
        slug: "nissan-march-advance",
        purchaseBenchmarkPct: 0.60,
      },
      expected: {
        totalCost: 161000,
        margin: 62298,
        costoPctCmu: 0.7210,
        tirBase: 0.8156,
        tirOperativa: 0.8564,
        tirCompleta: 1.0853,
        moic: 1.8909,
        paybackMonth: 13,
        kitGnv: 18000,
        ventaPlazos: 326224,
        cuotaMes1: 11767,
        cuotaMes36: 6347,
        decision: "COMPRAR",
        riesgoNivel: "MEDIO",
        diferencialM1: 7367,
        diferencialM3: 4341,
      },
    },
    {
      id: "CAL03",
      name: "Aveo 2022 — 100k compra, 25k rep",
      input: {
        modelId: 10,
        modelSlug: "chevrolet-aveo",
        year: 2022,
        cmu: 219640,
        insurerPrice: 100000,
        repairEstimate: 25000,
        conTanque: true,
      },
      modelData: {
        brand: "Chevrolet",
        model: "Aveo",
        variant: null as string | null,
        slug: "chevrolet-aveo",
        purchaseBenchmarkPct: 0.60,
      },
      expected: {
        totalCost: 143000,
        margin: 76640,
        costoPctCmu: 0.6511,
        tirBase: 1.0178,
        tirOperativa: 1.0591,
        tirCompleta: 1.4393,
        moic: 2.0914,
        paybackMonth: 11,
        kitGnv: 18000,
        ventaPlazos: 320884,
        cuotaMes1: 11574,
        cuotaMes36: 6257,
        decision: "COMPRAR",
        riesgoNivel: "MEDIO",
        diferencialM1: 7174,
        diferencialM3: 4154,
      },
    },
  ];

  for (const cal of CALIBRATION) {
    const assertions: Array<{ ok: boolean; msg: string }> = [];
    let actual: Record<string, any> = {};

    try {
      const result = evaluateOpportunity(
        cal.input,
        cal.modelData,
        { gnvRevenue: 4400 }  // $11/LEQ × 400 LEQ/mes = $4,400
      );

      actual = {
        totalCost: result.totalCost,
        margin: result.margin,
        costoPctCmu: result.costoPctCmu,
        tirBase: result.tirBase,
        tirOperativa: result.tirOperativa,
        tirCompleta: result.tirCompleta,
        moic: result.moic,
        paybackMonth: result.paybackMonth,
        kitGnv: result.kitGnv,
        ventaPlazos: result.ventaPlazos,
        cuotaMes1: result.cuotaMes1,
        cuotaMes36: result.cuotaMes36,
        decision: result.decision,
        riesgoNivel: result.riesgoCliente?.nivel,
        diferencialM1: result.riesgoCliente?.diferencialM1,
        diferencialM3: result.riesgoCliente?.diferencialM3,
      };

      const e = cal.expected;

      // ── Exact matches (integers) ──
      assertions.push(near(result.totalCost, e.totalCost, 500, "Total cost"));
      assertions.push(near(result.margin, e.margin, 500, "Margin"));
      assertions.push(near(result.kitGnv, e.kitGnv, 0, "Kit GNV"));
      assertions.push(near(result.ventaPlazos, e.ventaPlazos, 500, "Venta plazos"));
      assertions.push(near(result.cuotaMes1, e.cuotaMes1, 100, "Cuota mes 1"));
      assertions.push(near(result.cuotaMes36, e.cuotaMes36, 100, "Cuota mes 36"));

      // ── Percentage matches (±0.5%) ──
      assertions.push(near(result.costoPctCmu, e.costoPctCmu, 0.005, "%CMU"));
      assertions.push(near(result.tirBase, e.tirBase, 0.005, "TIR Base"));
      assertions.push(near(result.tirOperativa, e.tirOperativa, 0.005, "TIR Operativa"));
      assertions.push(near(result.tirCompleta, e.tirCompleta, 0.005, "TIR Completa"));
      assertions.push(near(result.moic, e.moic, 0.02, "MOIC"));

      // ── Exact matches (categorical) ──
      assertions.push(ok(result.paybackMonth === e.paybackMonth, `Payback: ${result.paybackMonth} = ${e.paybackMonth}`));
      assertions.push(ok(result.decision === e.decision, `Decision: ${result.decision} = ${e.decision}`));
      assertions.push(ok(result.riesgoCliente?.nivel === e.riesgoNivel, `Riesgo: ${result.riesgoCliente?.nivel} = ${e.riesgoNivel}`));

      // ── Risk differentials (±$200) ──
      assertions.push(near(result.riesgoCliente?.diferencialM1 || 0, e.diferencialM1, 200, "Dif M1"));
      assertions.push(near(result.riesgoCliente?.diferencialM3 || 0, e.diferencialM3, 200, "Dif M3"));

      results.push({
        id: cal.id,
        name: cal.name,
        pass: assertions.every(a => a.ok),
        assertions,
        actual,
      });

    } catch (err: any) {
      results.push({
        id: cal.id,
        name: cal.name,
        pass: false,
        assertions,
        actual,
        error: err.message,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CAL04 — PM CMU = P70 cap rule verification
  // March Sense 2021 with P70 market cap lower than CMU
  // When P70 is passed, it should cap precioContado to P70
  // ═══════════════════════════════════════════════════════════════════════
  {
    const calP70 = {
      id: "CAL04",
      name: "March Sense 2021 — PM CMU P70 cap at $190k",
      input: {
        modelId: 1,
        modelSlug: "nissan-march-sense",
        year: 2021,
        cmu: 223298,  // catalog CMU higher than P70
        insurerPrice: 123000,
        repairEstimate: 10000,
        conTanque: true,
      },
      modelData: {
        brand: "Nissan",
        model: "March",
        variant: "Sense" as string | null,
        slug: "nissan-march-sense",
        purchaseBenchmarkPct: 0.60,
      },
    };

    const assertions: Array<{ ok: boolean; msg: string }> = [];
    let actual: Record<string, any> = {};

    try {
      const resultWithP70 = evaluateOpportunity(
        calP70.input,
        calP70.modelData,
        { gnvRevenue: 4400, marketAvgPrice: 200000, marketP70: 190000 }
      );

      actual = {
        precioContado: resultWithP70.precioContado,
        precioCapped: resultWithP70.precioCapped,
        precioMaxCMU: resultWithP70.precioMaxCMU,
        marketP70: resultWithP70.marketP70,
        marketAvgPrice: resultWithP70.marketAvgPrice,
        totalCost: resultWithP70.totalCost,
        margin: resultWithP70.margin,
      };

      // P70 = 190k which is less than CMU 223k → precioContado should be capped to 190k
      assertions.push(ok(resultWithP70.precioCapped === true, `PV capped to P70: precioCapped=${resultWithP70.precioCapped}`));
      assertions.push(near(resultWithP70.precioContado, 190000, 0, "PV capped to P70"));
      assertions.push(near(resultWithP70.precioMaxCMU, 190000, 0, "precioMaxCMU = P70"));
      assertions.push(ok(resultWithP70.marketP70 === 190000, `marketP70 in result: ${resultWithP70.marketP70} = 190000`));
      assertions.push(ok(resultWithP70.marketAvgPrice === 200000, `marketAvgPrice preserved: ${resultWithP70.marketAvgPrice} = 200000`));
      // Margin = 190000 - 151000 = 39000
      assertions.push(near(resultWithP70.margin, 39000, 500, "Margin with P70 cap"));

      // Now test P70 > CMU — should NOT cap but may apply floor (PM×0.95)
      // P70=240k, floor=228k > CMU=223k → PV bumped to floor=228k (precioAjustado=true, not capped)
      const resultP70High = evaluateOpportunity(
        calP70.input,
        calP70.modelData,
        { gnvRevenue: 4400, marketAvgPrice: 250000, marketP70: 240000 }
      );
      assertions.push(ok(resultP70High.precioCapped === false, `P70 > CMU: not capped (precioCapped=${resultP70High.precioCapped})`));
      assertions.push(near(resultP70High.precioContado, 228000, 0, "PV = P70*0.95 floor when P70 > CMU"));

      // Test P70 = null but avg provided — should use avg as fallback
      const resultFallback = evaluateOpportunity(
        calP70.input,
        calP70.modelData,
        { gnvRevenue: 4400, marketAvgPrice: 185000, marketP70: null }
      );
      assertions.push(ok(resultFallback.precioCapped === true, `Avg fallback when P70=null: capped=${resultFallback.precioCapped}`));
      assertions.push(near(resultFallback.precioContado, 185000, 0, "PV = avg when P70 is null"));

      results.push({
        id: calP70.id,
        name: calP70.name,
        pass: assertions.every(a => a.ok),
        assertions,
        actual,
      });
    } catch (err: any) {
      results.push({
        id: "CAL04",
        name: "March Sense 2021 — PM CMU P70 cap at $190k",
        pass: false,
        assertions,
        actual,
        error: err.message,
      });
    }
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  console.log(`\n=== Calibration Regression (${results.length} cases) ===\n`);
  for (const r of results) {
    console.log(`${r.pass ? "✅" : "❌"} ${r.id}: ${r.name}`);
    if (!r.pass) {
      r.assertions.filter(a => !a.ok).forEach(a => console.log(`   ${a.msg}`));
      if (r.error) console.log(`   Error: ${r.error}`);
    }
  }
  console.log(`\n${passed}/${results.length} passed\n`);

  return { passed, failed, total: results.length, results };
}
