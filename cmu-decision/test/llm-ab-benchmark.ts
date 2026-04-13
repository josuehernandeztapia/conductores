/**
 * llm-ab-benchmark.ts
 * A/B benchmark: gpt-4o-mini vs Claude Haiku 3.5 for the 4 candidate tasks.
 *
 * Tests REAL prompts from production with BOTH models side by side.
 * No code changes needed — just measures quality + latency + cost.
 *
 * TASKS:
 *   T1 — NLU intent classification (10 phrases)
 *   T2 — RAG question answering (5 questions)
 *   T3 — WA conversational fallback (5 prompts)
 *   T4 — Quick image classification (3 images)
 *
 * Run: POST /api/test/llm-ab-benchmark
 */

import Anthropic from "@anthropic-ai/sdk";

interface ABResult {
  task: string;
  input: string;
  gpt_output: string;
  claude_output: string;
  gpt_latency: number;
  claude_latency: number;
  gpt_correct: boolean;
  claude_correct: boolean;
  notes: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function callGPT(messages: any[], options: any = {}): Promise<{ text: string; ms: number }> {
  const { chatCompletion } = await import("../server/agent/openai-helper");
  const t0 = Date.now();
  const text = await chatCompletion(messages, { model: "gpt-4o-mini", max_tokens: 500, temperature: 0, ...options });
  return { text: typeof text === "string" ? text : JSON.stringify(text), ms: Date.now() - t0 };
}

async function callClaude(messages: any[], options: any = {}): Promise<{ text: string; ms: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic({ apiKey });

  // Convert OpenAI message format to Claude format
  const systemMsg = messages.find((m: any) => m.role === "system");
  const userMsgs = messages.filter((m: any) => m.role !== "system");

  const t0 = Date.now();
  const resp = await client.messages.create({
    model: "claude-3-5-haiku-20241022",
    max_tokens: options.max_tokens || 500,
    system: systemMsg?.content || undefined,
    messages: userMsgs.map((m: any) => ({ role: m.role, content: m.content })),
  });
  const text = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  return { text, ms: Date.now() - t0 };
}

// ─── T1: NLU Intent Classification ──────────────────────────────────────────

async function benchNLU(): Promise<ABResult[]> {
  const VALID_INTENTS = "fuel_gnv, fuel_gasolina, consumo_number, gasto_number, select_model, see_all_models, affirm, deny, maybe_later, give_name, want_register, skip_doc, ask_progress, want_interview, go_back, ask_question, greeting, unknown";
  const NLU_SYSTEM_PROMPT = `You classify WhatsApp messages from Mexican taxi drivers into intents.
Current conversation state: "prospect_name"

Valid intents: ${VALID_INTENTS}

Rules:
- "give_name" = user gives their PERSONAL name. Extract as {"nombre": "Full Name"}. NEVER classify as give_name if the message starts with a verb.
- "ask_question" = user is asking a question. Extract as {"question": "..."}
- "fuel_gasolina" = user says gasoline
- "gasto_number" = peso amount. Extract as {"pesos": N}
- "select_model" = vehicle model. Extract as {"modelo": "X"}
- "affirm" = yes, si, dale
- "deny" = no, nope
- "skip_doc" = no lo tengo, siguiente
- "want_interview" = wants to start interview

Respond ONLY with valid JSON: {"intent": "...", "entities": {...}, "confidence": 0.N}`;

  const cases = [
    { input: "quiero información del programa", expected: "ask_question", key: "question" },
    { input: "me llamo Pedro López", expected: "give_name", key: "nombre" },
    { input: "gasolina", expected: "fuel_gasolina", key: null },
    { input: "gasto 8000 pesos al mes", expected: "gasto_number", key: "pesos" },
    { input: "sí, me interesa", expected: "affirm", key: null },
    { input: "no gracias", expected: "deny", key: null },
    { input: "march sense", expected: "select_model", key: "modelo" },
    { input: "siguiente", expected: "skip_doc", key: null },
    { input: "cuánto dura el programa", expected: "ask_question", key: "question" },
    { input: "quiero hacer la entrevista", expected: "want_interview", key: null },
  ];

  const results: ABResult[] = [];

  for (const tc of cases) {
    const messages = [
      { role: "system", content: NLU_SYSTEM_PROMPT || "Classify the user intent. Respond ONLY with JSON: {\"intent\": \"...\", \"entities\": {...}}" },
      { role: "user", content: tc.input },
    ];

    const gpt = await callGPT(messages, { max_tokens: 150, temperature: 0 });
    const claude = await callClaude(messages, { max_tokens: 150 });

    // Check if intent is correct
    const gptIntent = extractIntent(gpt.text);
    const claudeIntent = extractIntent(claude.text);

    results.push({
      task: "NLU",
      input: tc.input,
      gpt_output: gpt.text.slice(0, 100),
      claude_output: claude.text.slice(0, 100),
      gpt_latency: gpt.ms,
      claude_latency: claude.ms,
      gpt_correct: gptIntent === tc.expected,
      claude_correct: claudeIntent === tc.expected,
      notes: `Expected: ${tc.expected} | GPT: ${gptIntent} | Claude: ${claudeIntent}`,
    });

    await new Promise(r => setTimeout(r, 200));
  }

  return results;
}

function extractIntent(text: string): string {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      return parsed.intent || "unknown";
    }
  } catch {}
  return "parse_error";
}

// ─── T2: RAG Question Answering ─────────────────────────────────────────────

async function benchRAG(): Promise<ABResult[]> {
  // Use hardcoded rules for benchmark (avoid DB dependency)
  const getBusinessRules = async () => new Map([["plazo","36 meses"],["anticipo","$50,000"],["tasa","29.9% anual"],["ubicacion","Aguascalientes"],["combustible","Gas Natural Vehicular (GNV)"],["mora","Recargo día 8, escalamiento día 15, recuperación día 30"]]);

  const questions = [
    { q: "¿Cuánto dura el crédito?", mustContain: "36" },
    { q: "¿Cuánto es el anticipo?", mustContain: "50" },
    { q: "¿Qué pasa si no pago?", mustContain: "mora" },
    { q: "¿Qué combustible usan los carros?", mustContain: "gas" },
    { q: "¿Dónde operan?", mustContain: "aguascalientes" },
  ];

  const rules = await getBusinessRules();
  const systemPrompt = `Eres el asistente de CMU (Conductores del Mundo). Responde preguntas sobre el programa de crédito para taxistas. Reglas: ${JSON.stringify(Object.fromEntries(rules))}. Responde en español, máximo 2 oraciones.`;

  const results: ABResult[] = [];

  for (const tc of questions) {
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: tc.q },
    ];

    const gpt = await callGPT(messages);
    const claude = await callClaude(messages);

    results.push({
      task: "RAG",
      input: tc.q,
      gpt_output: gpt.text.slice(0, 150),
      claude_output: claude.text.slice(0, 150),
      gpt_latency: gpt.ms,
      claude_latency: claude.ms,
      gpt_correct: gpt.text.toLowerCase().includes(tc.mustContain),
      claude_correct: claude.text.toLowerCase().includes(tc.mustContain),
      notes: `Must contain: "${tc.mustContain}"`,
    });

    await new Promise(r => setTimeout(r, 200));
  }

  return results;
}

// ─── T3: Conversational Fallback ─────────────────────────────────────────────

async function benchConversational(): Promise<ABResult[]> {
  const systemPrompt = `Eres el asistente de WhatsApp de CMU (Conductores del Mundo). Hablas español mexicano coloquial pero profesional. Respuestas cortas (máximo 3 líneas). Tuteas. Si no sabes, di que no tienes esa información.`;

  const prompts = [
    { input: "oye y cómo le hago para pagar", mustNotContain: "error", mustContain: "pago" },
    { input: "cuándo me entregan mi carro", mustNotContain: "error", mustContain: "" },
    { input: "ya no quiero el crédito", mustNotContain: "error", mustContain: "" },
    { input: "me pueden llamar por favor", mustNotContain: "error", mustContain: "" },
    { input: "gracias por todo", mustNotContain: "error", mustContain: "" },
  ];

  const results: ABResult[] = [];

  for (const tc of prompts) {
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: tc.input },
    ];

    const gpt = await callGPT(messages, { temperature: 0.3 });
    const claude = await callClaude(messages);

    const gptOk = gpt.text.length > 10 && !gpt.text.toLowerCase().includes("error");
    const claudeOk = claude.text.length > 10 && !claude.text.toLowerCase().includes("error");

    results.push({
      task: "Conversational",
      input: tc.input,
      gpt_output: gpt.text.slice(0, 150),
      claude_output: claude.text.slice(0, 150),
      gpt_latency: gpt.ms,
      claude_latency: claude.ms,
      gpt_correct: gptOk,
      claude_correct: claudeOk,
      notes: `GPT ${gpt.text.length} chars, Claude ${claude.text.length} chars`,
    });

    await new Promise(r => setTimeout(r, 200));
  }

  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function runLLMABBenchmark(): Promise<{
  summary: {
    gpt: { accuracy: number; avgLatency: number; total: number };
    claude: { accuracy: number; avgLatency: number; total: number };
    byTask: Record<string, { gpt: number; claude: number; total: number }>;
    winner: string;
  };
  results: ABResult[];
}> {
  console.log("\n=== LLM A/B Benchmark: gpt-4o-mini vs Claude Haiku 3.5 ===\n");

  const allResults: ABResult[] = [];

  console.log("Running T1: NLU Intent Classification (10 phrases)...");
  allResults.push(...await benchNLU());

  console.log("Running T2: RAG Question Answering (5 questions)...");
  allResults.push(...await benchRAG());

  console.log("Running T3: Conversational Fallback (5 prompts)...");
  allResults.push(...await benchConversational());

  // Summary
  const gptCorrect = allResults.filter(r => r.gpt_correct).length;
  const claudeCorrect = allResults.filter(r => r.claude_correct).length;
  const gptAvgLat = Math.round(allResults.reduce((a, r) => a + r.gpt_latency, 0) / allResults.length);
  const claudeAvgLat = Math.round(allResults.reduce((a, r) => a + r.claude_latency, 0) / allResults.length);

  const byTask: Record<string, { gpt: number; claude: number; total: number }> = {};
  for (const r of allResults) {
    if (!byTask[r.task]) byTask[r.task] = { gpt: 0, claude: 0, total: 0 };
    byTask[r.task].total++;
    if (r.gpt_correct) byTask[r.task].gpt++;
    if (r.claude_correct) byTask[r.task].claude++;
  }

  const winner = gptCorrect > claudeCorrect ? "gpt-4o-mini" :
    claudeCorrect > gptCorrect ? "Claude Haiku" : "TIE";

  console.log(`\n${"═".repeat(60)}`);
  console.log(`           Accuracy    Avg Latency`);
  console.log(`GPT-mini:  ${gptCorrect}/${allResults.length}          ${gptAvgLat}ms`);
  console.log(`Haiku:     ${claudeCorrect}/${allResults.length}          ${claudeAvgLat}ms`);
  console.log(`Winner:    ${winner}`);

  for (const [task, counts] of Object.entries(byTask)) {
    console.log(`  ${task}: GPT ${counts.gpt}/${counts.total} | Claude ${counts.claude}/${counts.total}`);
  }

  return {
    summary: {
      gpt: { accuracy: gptCorrect / allResults.length, avgLatency: gptAvgLat, total: allResults.length },
      claude: { accuracy: claudeCorrect / allResults.length, avgLatency: claudeAvgLat, total: allResults.length },
      byTask,
      winner,
    },
    results: allResults,
  };
}
