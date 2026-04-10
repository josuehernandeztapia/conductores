/**
 * cross-check-e2e.ts
 * End-to-end cross-check regression test using REAL documents.
 *
 * Tests that the semáforo correctly fires red flags for:
 * 1. CSF with different name than INE → nombre_mismatch
 * 2. Estado de cuenta with different name → nombre_mismatch
 * 3. Concesión COLECTIVO FORÁNEO → tipo_no_taxi (REJECTION)
 * 4. Tarjeta circulación ESCOLAR → no_es_taxi (REJECTION)
 * 5. Comprobante domicilio different address → domicilio_mismatch
 *
 * Run: DATABASE_URL=<neon> OPENAI_API_KEY=<key> npx ts-node test/cross-check-e2e.ts
 */

import * as fs from "fs";
import * as path from "path";

const FIXTURES = path.join(__dirname, "fixtures/cross-check-real");
const expected = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "expected.json"), "utf-8")
);

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition: boolean, msg: string, detail?: string) {
  total++;
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${msg}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function assertFlag(flags: string[], expectedFlag: string, docFile: string) {
  assert(
    flags.includes(expectedFlag),
    `Flag '${expectedFlag}' fired`,
    `Got flags: [${flags.join(", ")}] for ${path.basename(docFile)}`
  );
}

function assertNoFlag(flags: string[], notExpectedFlag: string, docFile: string) {
  assert(
    !flags.includes(notExpectedFlag),
    `Flag '${notExpectedFlag}' NOT fired (expected exception)`,
    `Incorrectly got flags: [${flags.join(", ")}] for ${path.basename(docFile)}`
  );
}

async function runTest() {
  const { classifyAndValidateDoc, DOC_ORDER } = await import(
    "../server/agent/vision"
  );

  console.log("\n=== CMU Cross-Check E2E Regression Tests ===");
  console.log(`Using ${expected.test_cases.length} real documents from Angeles (09-04-2026)\n`);

  // Ground truth from INE
  const groundTruth = expected.ground_truth;
  console.log(
    `Ground truth (INE): ${groundTruth.nombre} | CURP: ${groundTruth.curp}`
  );
  console.log(`Domicilio: ${groundTruth.domicilio}\n`);

  for (const tc of expected.test_cases) {
    const imgPath = path.join(FIXTURES, tc.file);
    if (!fs.existsSync(imgPath)) {
      console.log(`\n⚠️  SKIP: ${tc.file} (not found)`);
      continue;
    }

    console.log(`\n── ${tc.doc_type}: ${tc.file}`);
    if (tc.notes) console.log(`   ${tc.notes}`);

    const imgBase64 = `data:image/jpeg;base64,${fs
      .readFileSync(imgPath)
      .toString("base64")}`;

    let result: any;
    try {
      result = await classifyAndValidateDoc(
        imgBase64,
        tc.doc_type,
        DOC_ORDER,
        tc.existing_data || {}
      );
    } catch (e: any) {
      console.error(`  ❌ classifyAndValidateDoc threw: ${e.message}`);
      failed++;
      total++;
      continue;
    }

    const flags = result.cross_check_flags || [];
    const detected = result.detected_type;

    // 1. Correct doc type detected
    assert(
      detected === tc.doc_type,
      `Classified as '${tc.doc_type}'`,
      `Got: '${detected}'`
    );

    // 2. Expected flags all present
    for (const expectedFlag of tc.expected_flags || []) {
      assertFlag(flags, expectedFlag, tc.file);
    }

    // 3. Flags that must NOT be present
    for (const notFlag of tc.expected_flags_NOT || []) {
      assertNoFlag(flags, notFlag, tc.file);
    }

    // 4. Rejection docs must have at least one rejection flag
    if (tc.rejection) {
      const hasRejectionFlag = flags.some((f: string) =>
        ["tipo_no_taxi", "no_es_taxi", "municipio_no_ags"].includes(f)
      );
      assert(
        hasRejectionFlag,
        `Rejection flag present (tipo_no_taxi | no_es_taxi | municipio_no_ags)`,
        `Got: [${flags.join(", ")}]`
      );
    }

    // 5. Legibility
    assert(
      result.is_legible !== false,
      `Document legible`,
      `Legibility: ${result.is_legible}`
    );

    // Show extracted data summary
    const ext = result.extracted_data || {};
    const keyFields = ["nombre", "titular", "nombre_s", "curp", "placa", "tipo_servicio", "clabe"];
    const extracted = keyFields
      .filter((k) => ext[k])
      .map((k) => `${k}="${ext[k]}"`)
      .join(", ");
    if (extracted) console.log(`  → Extracted: ${extracted}`);
    if (flags.length > 0) console.log(`  → Flags: [${flags.join(", ")}]`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(50)}`);
  console.log(`TOTAL: ${total} assertions | ${passed} passed | ${failed} failed`);

  if (failed > 0) {
    console.error(
      `\n⚠️  ${failed} test(s) failed — cross-check validation needs fixing.`
    );
    process.exit(1);
  } else {
    console.log(
      "\n✅ All cross-check E2E tests passed — semáforo fires correctly on real documents."
    );
  }
}

runTest().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
