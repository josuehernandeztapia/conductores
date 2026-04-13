/**
 * vision-benchmark.ts
 * Head-to-head benchmark: GPT-4o vs Claude Sonnet 4 for document classification + cross-check.
 *
 * Runs the SAME 10 real documents through both models and compares:
 * - Classification accuracy (correct doc type detected)
 * - Cross-check flag accuracy (expected flags fired)
 * - Extraction quality (key fields extracted)
 * - Latency (time per document)
 * - Cost estimate (input/output tokens)
 *
 * Run via API: POST https://cmu-originacion.fly.dev/api/test/vision-benchmark
 */

import * as fs from "fs";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";

const FIXTURES = path.join(__dirname, "fixtures/cross-check-real");

interface BenchResult {
  file: string;
  doc_type: string;
  model: string;
  detected_type: string;
  type_correct: boolean;
  expected_flags: string[];
  actual_flags: string[];
  flags_correct: boolean;
  missing_flags: string[];
  extra_flags: string[];
  is_legible: boolean;
  extracted_keys: string[];
  latency_ms: number;
  error?: string;
}

// ─── GPT-4o runner (existing) ────────────────────────────────────────────────

async function runGPT4o(
  imageBase64: string,
  expectedType: string,
  docOrder: any[],
  existingData: Record<string, any>,
): Promise<{ result: any; latency_ms: number }> {
  const { classifyAndValidateDoc } = await import("../server/agent/vision");
  const start = Date.now();
  const result = await classifyAndValidateDoc(imageBase64, expectedType, docOrder, existingData);
  return { result, latency_ms: Date.now() - start };
}

// ─── Claude Sonnet runner ────────────────────────────────────────────────────

async function runClaudeSonnet(
  imageBase64: string,
  expectedType: string,
  docOrder: any[],
  existingData: Record<string, any>,
): Promise<{ result: any; latency_ms: number }> {
  const { buildVisionPrompt } = await import("../server/agent/vision");
  
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const client = new Anthropic({ apiKey });
  const prompt = buildVisionPrompt(expectedType, docOrder, existingData);

  const start = Date.now();

  // Determine media type from base64 header
  let mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" = "image/jpeg";
  let base64Data = imageBase64;
  if (imageBase64.startsWith("data:")) {
    const match = imageBase64.match(/^data:(image\/\w+);base64,(.+)/);
    if (match) {
      mediaType = match[1] as any;
      base64Data = match[2];
    }
  }

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2500,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64Data },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  const latency_ms = Date.now() - start;
  const text = response.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("")
    .trim();

  // Parse JSON
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      result: {
        detected_type: "unknown",
        matches_expected: false,
        is_legible: false,
        extracted_data: {},
        cross_check_flags: [],
        confidence: 0,
        rejection_reason: "Could not parse Claude response as JSON",
      },
      latency_ms,
    };
  }

  const parsed = JSON.parse(jsonMatch[0]);
  const validDocKeys = docOrder.map((d: any) => d.key);
  const detectedType = validDocKeys.includes(parsed.detected_type)
    ? parsed.detected_type
    : "unknown";

  return {
    result: {
      detected_type: detectedType,
      matches_expected: detectedType === expectedType,
      is_legible: parsed.is_legible === true,
      extracted_data: parsed.extracted_data || {},
      cross_check_flags: Array.isArray(parsed.cross_check_flags) ? parsed.cross_check_flags : [],
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      rejection_reason: parsed.rejection_reason || undefined,
    },
    latency_ms,
  };
}

// ─── Main benchmark ──────────────────────────────────────────────────────────

export async function runVisionBenchmark(): Promise<{
  summary: {
    gpt4o: { accuracy: number; flagAccuracy: number; avgLatency: number; total: number };
    claude: { accuracy: number; flagAccuracy: number; avgLatency: number; total: number };
    winner: string;
  };
  details: Array<{
    file: string;
    doc_type: string;
    gpt4o: BenchResult;
    claude: BenchResult;
  }>;
}> {
  const { DOC_ORDER } = await import("../server/agent/vision");
  const expectedJson = JSON.parse(fs.readFileSync(path.join(FIXTURES, "expected.json"), "utf-8"));
  const testCases = expectedJson.test_cases;

  const details: Array<{ file: string; doc_type: string; gpt4o: BenchResult; claude: BenchResult }> = [];
  const gpt4oResults: BenchResult[] = [];
  const claudeResults: BenchResult[] = [];

  console.log(`\n=== Vision Benchmark: GPT-4o vs Claude Sonnet ===`);
  console.log(`Documents: ${testCases.length}\n`);

  for (const tc of testCases) {
    const imgPath = path.join(FIXTURES, tc.file);
    if (!fs.existsSync(imgPath)) {
      console.log(`⚠️ SKIP: ${tc.file} (not found)`);
      continue;
    }

    const imgBase64 = fs.readFileSync(imgPath).toString("base64");
    const expectedFlags = tc.expected_flags || [];
    console.log(`── ${tc.doc_type}: ${tc.file}`);

    // Run GPT-4o
    let gpt: BenchResult;
    try {
      const { result, latency_ms } = await runGPT4o(imgBase64, tc.doc_type, DOC_ORDER, tc.existing_data || {});
      const actualFlags = result.cross_check_flags || [];
      const missingFlags = expectedFlags.filter((f: string) => !actualFlags.includes(f));
      const extraFlags = actualFlags.filter((f: string) => !expectedFlags.includes(f) && !(tc.expected_flags_extended || []).includes(f));
      gpt = {
        file: tc.file, doc_type: tc.doc_type, model: "gpt-4o",
        detected_type: result.detected_type,
        type_correct: result.detected_type === tc.doc_type,
        expected_flags: expectedFlags,
        actual_flags: actualFlags,
        flags_correct: missingFlags.length === 0,
        missing_flags: missingFlags,
        extra_flags: extraFlags,
        is_legible: result.is_legible,
        extracted_keys: Object.keys(result.extracted_data || {}),
        latency_ms,
      };
      console.log(`  GPT-4o:  ${gpt.type_correct ? "✅" : "❌"} type | ${gpt.flags_correct ? "✅" : "❌"} flags | ${latency_ms}ms`);
    } catch (e: any) {
      gpt = {
        file: tc.file, doc_type: tc.doc_type, model: "gpt-4o",
        detected_type: "error", type_correct: false,
        expected_flags: expectedFlags, actual_flags: [], flags_correct: false,
        missing_flags: expectedFlags, extra_flags: [],
        is_legible: false, extracted_keys: [], latency_ms: 0, error: e.message,
      };
      console.log(`  GPT-4o:  ❌ ERROR: ${e.message}`);
    }

    // Run Claude Sonnet
    let claude: BenchResult;
    try {
      const { result, latency_ms } = await runClaudeSonnet(imgBase64, tc.doc_type, DOC_ORDER, tc.existing_data || {});
      const actualFlags = result.cross_check_flags || [];
      const missingFlags = expectedFlags.filter((f: string) => !actualFlags.includes(f));
      const extraFlags = actualFlags.filter((f: string) => !expectedFlags.includes(f) && !(tc.expected_flags_extended || []).includes(f));
      claude = {
        file: tc.file, doc_type: tc.doc_type, model: "claude-sonnet-4",
        detected_type: result.detected_type,
        type_correct: result.detected_type === tc.doc_type,
        expected_flags: expectedFlags,
        actual_flags: actualFlags,
        flags_correct: missingFlags.length === 0,
        missing_flags: missingFlags,
        extra_flags: extraFlags,
        is_legible: result.is_legible,
        extracted_keys: Object.keys(result.extracted_data || {}),
        latency_ms,
      };
      console.log(`  Claude:  ${claude.type_correct ? "✅" : "❌"} type | ${claude.flags_correct ? "✅" : "❌"} flags | ${latency_ms}ms`);
    } catch (e: any) {
      claude = {
        file: tc.file, doc_type: tc.doc_type, model: "claude-sonnet-4",
        detected_type: "error", type_correct: false,
        expected_flags: expectedFlags, actual_flags: [], flags_correct: false,
        missing_flags: expectedFlags, extra_flags: [],
        is_legible: false, extracted_keys: [], latency_ms: 0, error: e.message,
      };
      console.log(`  Claude:  ❌ ERROR: ${e.message}`);
    }

    gpt4oResults.push(gpt);
    claudeResults.push(claude);
    details.push({ file: tc.file, doc_type: tc.doc_type, gpt4o: gpt, claude });

    // Small delay between docs to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  const gpt4oAccuracy = gpt4oResults.filter(r => r.type_correct).length / gpt4oResults.length;
  const gpt4oFlagAcc = gpt4oResults.filter(r => r.flags_correct).length / gpt4oResults.length;
  const gpt4oAvgLat = Math.round(gpt4oResults.reduce((a, r) => a + r.latency_ms, 0) / gpt4oResults.length);

  const claudeAccuracy = claudeResults.filter(r => r.type_correct).length / claudeResults.length;
  const claudeFlagAcc = claudeResults.filter(r => r.flags_correct).length / claudeResults.length;
  const claudeAvgLat = Math.round(claudeResults.reduce((a, r) => a + r.latency_ms, 0) / claudeResults.length);

  // Score: 60% flag accuracy + 30% type accuracy + 10% latency bonus
  const gpt4oScore = gpt4oFlagAcc * 0.6 + gpt4oAccuracy * 0.3 + (gpt4oAvgLat < claudeAvgLat ? 0.1 : 0);
  const claudeScore = claudeFlagAcc * 0.6 + claudeAccuracy * 0.3 + (claudeAvgLat < gpt4oAvgLat ? 0.1 : 0);
  const winner = gpt4oScore > claudeScore ? "GPT-4o" : claudeScore > gpt4oScore ? "Claude Sonnet" : "TIE";

  const summary = {
    gpt4o: { accuracy: gpt4oAccuracy, flagAccuracy: gpt4oFlagAcc, avgLatency: gpt4oAvgLat, total: gpt4oResults.length },
    claude: { accuracy: claudeAccuracy, flagAccuracy: claudeFlagAcc, avgLatency: claudeAvgLat, total: claudeResults.length },
    winner,
  };

  console.log(`\n${"═".repeat(60)}`);
  console.log(`GPT-4o:  Type ${(gpt4oAccuracy * 100).toFixed(0)}% | Flags ${(gpt4oFlagAcc * 100).toFixed(0)}% | Avg ${gpt4oAvgLat}ms`);
  console.log(`Claude:  Type ${(claudeAccuracy * 100).toFixed(0)}% | Flags ${(claudeFlagAcc * 100).toFixed(0)}% | Avg ${claudeAvgLat}ms`);
  console.log(`Winner:  ${winner}`);

  return { summary, details };
}
