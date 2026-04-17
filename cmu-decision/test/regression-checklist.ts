/**
 * REGRESSION CHECKLIST — Run before and after any refactor
 * 
 * Tests the critical paths that MUST work for each role.
 * Uses the live API endpoints where possible, simulates messages where not.
 * 
 * npx tsx test/regression-checklist.ts
 * POST /api/test/regression-checklist
 */

import { evaluateOpportunity } from "../server/evaluation-engine";
import { answerQuestion } from "../server/agent/rag";
import { postOCRValidation, auditExpediente, _namesMatch } from "../server/agent/post-ocr-validation";

interface TestResult {
  id: string;
  category: string;
  description: string;
  pass: boolean;
  error?: string;
}

export async function runRegressionChecklist(): Promise<{ passed: number; failed: number; total: number; results: TestResult[] }> {
  const results: TestResult[] = [];

  function test(id: string, category: string, description: string, fn: () => boolean | string) {
    try {
      const result = fn();
      const pass = result === true;
      results.push({ id, category, description, pass, error: pass ? undefined : String(result) });
    } catch (e: any) {
      results.push({ id, category, description, pass: false, error: e.message });
    }
  }

  async function testAsync(id: string, category: string, description: string, fn: () => Promise<boolean | string>) {
    try {
      const result = await fn();
      const pass = result === true;
      results.push({ id, category, description, pass, error: pass ? undefined : String(result) });
    } catch (e: any) {
      results.push({ id, category, description, pass: false, error: e.message });
    }
  }

  // ═══════════════════════════════════════
  // EVAL ENGINE — Must always work
  // ═══════════════════════════════════════

  test("EVAL01", "Evaluation", "March Sense 2021 basic eval returns COMPRAR", () => {
    const r = evaluateOpportunity(
      { modelId: 1, modelSlug: "nissan-march-sense", year: 2021, cmu: 195000, insurerPrice: 123000, repairEstimate: 10000, conTanque: true },
      { brand: "Nissan", model: "March", variant: "Sense", slug: "nissan-march-sense", purchaseBenchmarkPct: 0.60 },
      { gnvRevenue: 4400 },
    );
    return r.decision === "COMPRAR" ? true : `Decision: ${r.decision}`;
  });

  test("EVAL02", "Evaluation", "P70 cap works (CMU > P70 → capped)", () => {
    const r = evaluateOpportunity(
      { modelId: 1, modelSlug: "test", year: 2021, cmu: 250000, insurerPrice: 160000, repairEstimate: 0, conTanque: true },
      { brand: "VW", model: "Vento", variant: null, slug: "vw-vento", purchaseBenchmarkPct: 0.60 },
      { gnvRevenue: 4400, marketP70: 200000 },
    );
    return r.precioCapped && r.precioContado === 200000 ? true : `capped=${r.precioCapped} precio=${r.precioContado}`;
  });

  test("EVAL03", "Evaluation", "German amortization: cuota mes 1 > cuota mes 36", () => {
    const r = evaluateOpportunity(
      { modelId: 1, modelSlug: "test", year: 2021, cmu: 200000, insurerPrice: 100000, repairEstimate: 10000, conTanque: true },
      { brand: "Chevrolet", model: "Aveo", variant: null, slug: "chev-aveo", purchaseBenchmarkPct: 0.60 },
      { gnvRevenue: 4400 },
    );
    return r.cuotaMes1 > r.cuotaMes36 ? true : `mes1=${r.cuotaMes1} mes36=${r.cuotaMes36}`;
  });

  // ═══════════════════════════════════════
  // RAG — FAQ answers
  // ═══════════════════════════════════════

  await testAsync("RAG01", "RAG", "'documentos' returns doc list with INE", async () => {
    const a = await answerQuestion("documentos");
    return a && a.includes("INE") ? true : `answer=${a?.slice(0, 50) || 'null'}`;
  });

  await testAsync("RAG02", "RAG", "'requisitos' returns doc list with vigencia", async () => {
    const a = await answerQuestion("requisitos");
    return a && a.includes("vigencia") ? true : `answer=${a?.slice(0, 50) || 'null'}`;
  });

  await testAsync("RAG03", "RAG", "'qué es CMU' returns program description", async () => {
    const a = await answerQuestion("qué es CMU");
    return a && a.includes("gas natural") ? true : `answer=${a?.slice(0, 50) || 'null'}`;
  });

  await testAsync("RAG04", "RAG", "'enganche' returns no anticipo", async () => {
    const a = await answerQuestion("necesito dar enganche");
    return a && a.toLowerCase().includes("no hay anticipo") ? true : `answer=${a?.slice(0, 50) || 'null'}`;
  });

  await testAsync("RAG05", "RAG", "'dónde cargo gas' says convenio CMU (not NATGAS)", async () => {
    const a = await answerQuestion("dónde cargo gas");
    return a && a.includes("convenio CMU") && !a.includes("NATGAS") ? true : `answer=${a?.slice(0, 80) || 'null'}`;
  });

  await testAsync("RAG06", "RAG", "'es una estafa' returns legitimacy answer", async () => {
    const a = await answerQuestion("es una estafa");
    return a && a.includes("registrada") ? true : `answer=${a?.slice(0, 50) || 'null'}`;
  });

  await testAsync("RAG07", "RAG", "'march 120k rep 10k' does NOT match RAG (goes to eval)", async () => {
    const a = await answerQuestion("march 120k rep 10k");
    return a === null || a === undefined ? true : `RAG should NOT match but returned: ${a?.slice(0, 50)}`;
  });

  // ═══════════════════════════════════════
  // NAME MATCHER
  // ═══════════════════════════════════════

  test("NAME01", "NameMatcher", "HDZ. → HERNANDEZ", () => {
    return _namesMatch("MA. HDZ.", "MARIA HERNANDEZ") ? true : "false";
  });

  test("NAME02", "NameMatcher", "Different people don't match", () => {
    return !_namesMatch("JUAN PEREZ SANCHEZ", "MARIA TORRES DIAZ") ? true : "matched but shouldn't";
  });

  test("NAME03", "NameMatcher", "Bancario order matches", () => {
    return _namesMatch("HERNANDEZ DE LA CRUZ MA GUADALUPE", "MARIA GUADALUPE HERNANDEZ DE LA CRUZ") ? true : "false";
  });

  // ═══════════════════════════════════════
  // POST-OCR VALIDATION
  // ═══════════════════════════════════════

  test("OCR01", "PostOCR", "CURP format validation catches bad CURP", () => {
    const r = postOCRValidation("ine_frente", { curp: "INVALID" }, {}, []);
    return r.addedFlags.includes("curp_formato_invalido") ? true : `flags=${r.addedFlags.join(',')}`;
  });

  test("OCR02", "PostOCR", "Name mismatch detected between docs", () => {
    const r = postOCRValidation("factura_vehiculo",
      { receptor_nombre: "JUAN PEREZ" },
      { ine_frente: { nombre: "MARIA", apellido_paterno: "TORRES", apellido_materno: "DIAZ" } },
      [],
    );
    return r.addedFlags.includes("nombre_mismatch") ? true : `flags=${r.addedFlags.join(',')}`;
  });

  test("OCR03", "PostOCR", "Concesion municipio check catches non-AGS", () => {
    const r = postOCRValidation("concesion",
      { titular: "PEDRO LOPEZ", municipio: "León, Guanajuato", tipo_servicio: "TAXI" },
      { ine_frente: { nombre: "PEDRO", apellido_paterno: "LOPEZ" } },
      [],
    );
    return r.addedFlags.includes("municipio_no_ags") ? true : `flags=${r.addedFlags.join(',')}`;
  });

  // ═══════════════════════════════════════
  // AUDIT
  // ═══════════════════════════════════════

  test("AUD01", "Audit", "Clean expediente has 0 errors", () => {
    const a = auditExpediente({
      ine_frente: { nombre: "PEDRO", apellido_paterno: "LOPEZ", apellido_materno: "GARCIA", curp: "LOGP650312HASRRD09" },
      csf: { nombre: "PEDRO LOPEZ GARCIA", curp: "LOGP650312HASRRD09", rfc: "LOGP650312QR5" },
    });
    const errors = a.alerts.filter(al => al.severity === "error");
    return errors.length === 0 ? true : `${errors.length} errors: ${errors.map(e => e.message).join(', ')}`;
  });

  test("AUD02", "Audit", "CURP mismatch detected in audit", () => {
    const a = auditExpediente({
      ine_frente: { nombre: "PEDRO", apellido_paterno: "LOPEZ", curp: "LOGP650312HASRRD09" },
      csf: { nombre: "PEDRO LOPEZ", curp: "LOGP650312HASRRD07", rfc: "LOGP650312QR5" },
    });
    const curpErrors = a.alerts.filter(al => al.field === "curp");
    return curpErrors.length > 0 ? true : "no CURP error detected";
  });

  // ═══════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  console.log(`\n=== Regression Checklist (${results.length} tests) ===\n`);

  let currentCat = "";
  for (const r of results) {
    if (r.category !== currentCat) {
      currentCat = r.category;
      console.log(`\n── ${currentCat} ──\n`);
    }
    const icon = r.pass ? "✅" : "❌";
    console.log(`${icon} ${r.id}: ${r.description}`);
    if (!r.pass) console.log(`   ${r.error}`);
  }

  console.log(`\n${passed}/${results.length} passed\n`);

  return { passed, failed, total: results.length, results };
}

// Direct execution
if (process.argv[1]?.includes("regression-checklist")) {
  runRegressionChecklist().then(r => {
    if (r.failed > 0) process.exit(1);
  });
}
