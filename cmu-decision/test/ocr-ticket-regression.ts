/**
 * ocr-ticket-regression.ts
 * Regression tests for Natgas ticket OCR extraction.
 * Uses REAL tickets from the Angeles chat session (09-04-2026).
 *
 * Run: npx ts-node test/ocr-ticket-regression.ts
 *
 * Validates:
 * 1. Vision correctly classifies ticket as 'historial_gnv' (not INE/licencia/etc.)
 * 2. Placa extracted correctly
 * 3. Litros extracted correctly
 * 4. Cross-check detects placa mismatch between tickets
 * 5. Monthly LEQ = avg(litros) * 26 days is calculated correctly
 */

import * as fs from "fs";
import * as path from "path";

const FIXTURES_DIR = path.join(__dirname, "fixtures/tickets-gnv");
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "expected.json"), "utf-8"));

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string, detail?: any) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${msg}`, detail || "");
    failed++;
  }
}

async function runOCRTest() {
  // Lazy-load vision to avoid startup cost
  const { classifyAndValidateDoc } = await import("../server/agent/vision");

  console.log("\n=== OCR Ticket Regression Tests ===\n");

  const results: Array<{ placa: string; litros: number }> = [];

  for (const ticket of expected.tickets) {
    console.log(`\n📄 Testing: ${ticket.file}`);
    const imgPath = path.join(FIXTURES_DIR, ticket.file);
    const imgBase64 = fs.readFileSync(imgPath).toString("base64");

    let result: any;
    try {
      result = await classifyAndValidateDoc(imgBase64, "image/jpeg", null, null);
    } catch (e: any) {
      console.error(`  ❌ classifyAndValidateDoc threw: ${e.message}`);
      failed++;
      continue;
    }

    const ext = result.extracted_data || {};

    // 1. Correct classification
    assert(
      result.detected_type === ticket.expected_type,
      `Classified as '${ticket.expected_type}'`,
      `Got: '${result.detected_type}'`
    );

    // 2. Placa extracted
    const placa = ext.placa || ext.plate || ext.numero_placa || "";
    assert(
      placa.replace(/\s/g, "").toUpperCase() === ticket.expected_data.placa,
      `Placa = ${ticket.expected_data.placa}`,
      `Got: '${placa}'`
    );

    // 3. Litros extracted
    const litros = parseFloat(ext.litros || ext.cantidad || 0);
    assert(
      Math.abs(litros - ticket.expected_data.litros) < 0.5,
      `Litros = ${ticket.expected_data.litros}`,
      `Got: ${litros}`
    );

    // 4. Total / monto
    const total = parseFloat(String(ext.monto || ext.total || ext.total_factura || 0).replace(/[$,]/g, ""));
    assert(
      Math.abs(total - ticket.expected_data.total) < 5,
      `Total = $${ticket.expected_data.total}`,
      `Got: $${total}`
    );

    // 5. No false cross-check flags (each ticket is valid individually)
    const flags = result.cross_check_flags || [];
    assert(
      !flags.includes("DOCUMENTO_INVALIDO") && !flags.includes("TIPO_INCORRECTO"),
      `No invalid flags`,
      `Flags: ${flags.join(", ")}`
    );

    results.push({ placa, litros });
    console.log(`  → Extracted: placa=${placa} | litros=${litros} | total=$${total}`);
  }

  // ── Cross-check: placa mismatch between tickets ──────────────────────────
  console.log("\n📊 Cross-check: Placa consistency between tickets");
  if (results.length >= 2) {
    const placas = results.map(r => r.placa.replace(/\s/g, "").toUpperCase());
    const allSame = placas.every(p => p === placas[0]);
    assert(
      !allSame,  // We EXPECT mismatch (different cars in test fixtures)
      `Placa mismatch detected between tickets (expected — different cars)`,
      `Placas: ${placas.join(", ")}`
    );
  }

  // ── Monthly LEQ calculation ───────────────────────────────────────────────
  console.log("\n📊 Monthly LEQ calculation");
  const litrosValues = results.map(r => r.litros).filter(l => l > 0);
  if (litrosValues.length > 0) {
    const avg = litrosValues.reduce((a, b) => a + b, 0) / litrosValues.length;
    const monthlyLeq = Math.round(avg * 26);
    assert(
      Math.abs(avg - expected.cross_check_rules.expected_avg_litros) < 5,
      `Avg litros/ticket = ${expected.cross_check_rules.expected_avg_litros}`,
      `Got: ${avg.toFixed(2)}`
    );
    assert(
      Math.abs(monthlyLeq - expected.cross_check_rules.expected_monthly_leq) < 50,
      `Monthly LEQ = ${expected.cross_check_rules.expected_monthly_leq} (avg × 26 days)`,
      `Got: ${monthlyLeq}`
    );
    assert(
      monthlyLeq >= expected.cross_check_rules.umbral_minimo_leq_mes,
      `Monthly LEQ ≥ ${expected.cross_check_rules.umbral_minimo_leq_mes} (umbral mínimo)`,
      `Got: ${monthlyLeq}`
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("\n⚠️  Some tests failed — OCR needs fixing before deploy.");
    process.exit(1);
  } else {
    console.log("\n✅ All OCR regression tests passed.");
  }
}

runOCRTest().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
