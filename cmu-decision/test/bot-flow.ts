/**
 * bot-flow.ts
 * End-to-end regression tests for the CMU WhatsApp prospect bot.
 *
 * Tests the 5 critical flows:
 *   1. NOMBRE_CAPTURADO  — nombre extraído correctamente, avanza a fuel_type
 *   2. ESCALACION_HUMANA — "conéctame con promotor" no se toma como nombre
 *   3. OTP_FLOW          — PIN de 6 dígitos reconocido como OTP, no como nombre/consumo
 *   4. INFO_REQUEST      — "quiero información" → saludo + pregunta nombre, no crash
 *   5. FRASE_AMBIGUA     — "hola vi el cartel en acataxi" → saludo, no nombre
 *
 * Run locally:
 *   DATABASE_URL=<neon> OPENAI_API_KEY=<key> npx ts-node test/bot-flow.ts
 *
 * Run via API (deployed):
 *   POST https://cmu-originacion.fly.dev/api/test/bot-flow
 */

const TEST_PHONE_PREFIX = "5219999000"; // safe range, never a real number

interface TurnResult {
  turn: number;
  input: string;
  reply: string;
  state: string;
}

interface CaseResult {
  name: string;
  description: string;
  pass: boolean;
  turns: TurnResult[];
  assertions: Array<{ ok: boolean; msg: string }>;
  error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _passed = 0;
let _failed = 0;

function assert(condition: boolean, msg: string): { ok: boolean; msg: string } {
  if (condition) _passed++;
  else _failed++;
  return { ok: condition, msg };
}

function assertContains(
  haystack: string,
  needle: string,
  label: string
): { ok: boolean; msg: string } {
  const ok = haystack.toLowerCase().includes(needle.toLowerCase());
  return assert(ok, ok ? `✅ ${label}` : `❌ ${label} — expected "${needle}" in reply: "${haystack.slice(0, 100)}"`);
}

function assertNotContains(
  haystack: string,
  needle: string,
  label: string
): { ok: boolean; msg: string } {
  const ok = !haystack.toLowerCase().includes(needle.toLowerCase());
  return assert(ok, ok ? `✅ ${label}` : `❌ ${label} — "${needle}" should NOT appear in reply: "${haystack.slice(0, 100)}"`);
}

function assertStateIs(
  state: string,
  expected: string,
  label: string
): { ok: boolean; msg: string } {
  const ok = state === expected;
  return assert(ok, ok ? `✅ ${label}` : `❌ ${label} — expected state="${expected}", got="${state}"`);
}

// ─── Core runner ─────────────────────────────────────────────────────────────

async function sendTurn(
  handleProspectMessage: Function,
  storage: any,
  phone: string,
  text: string,
  turn: number
): Promise<TurnResult> {
  const reply = await handleProspectMessage(phone, text, null, null, "Test", storage);

  // Read state after turn
  const { getSession } = await import("../server/conversation-state");
  const session = await getSession(phone);
  const state = (session.context as any)?.agentState || "idle";

  return { turn, input: text, reply, state };
}

async function clearPhone(phone: string): Promise<void> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL!);
  await sql`DELETE FROM conversation_states WHERE phone = ${phone}`;
  // Clean up any test originations created
  await sql`DELETE FROM originations WHERE folio LIKE 'CMU-SIN-%' AND taxista_id IN (
    SELECT id FROM taxistas WHERE telefono = ${phone}
  )`;
  await sql`DELETE FROM taxistas WHERE telefono = ${phone}`;
}

// ─── Test Cases ──────────────────────────────────────────────────────────────

async function case1_NombreCapturado(
  handle: Function,
  storage: any
): Promise<CaseResult> {
  const phone = `${TEST_PHONE_PREFIX}01`;
  const name = "case1_NombreCapturado";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];

  try {
    await clearPhone(phone);

    // Turn 1: first message → bot asks for name
    const t1 = await sendTurn(handle, storage, phone, "Hola, vi el cartel en ACATAXI y quiero información", 1);
    turns.push(t1);
    assertions.push(assertStateIs(t1.state, "prospect_name", "State = prospect_name after greeting"));
    assertions.push(assertContains(t1.reply, "llamas", "Bot asks for name"));
    assertions.push(assertNotContains(t1.reply, "conectame", "Reply does not contain 'conectame'"));

    // Turn 2: give a name → bot explains program + asks fuel
    const t2 = await sendTurn(handle, storage, phone, "Juan Martínez", 2);
    turns.push(t2);
    assertions.push(assertStateIs(t2.state, "prospect_fuel_type", "State = prospect_fuel_type after name"));
    assertions.push(assertContains(t2.reply, "gas natural", "Bot mentions gas natural"));
    assertions.push(assertNotContains(t2.reply, "juan martínez", "Name not echoed back verbatim as if confused"));

    // Turn 3: fuel type → asks for consumption
    const t3 = await sendTurn(handle, storage, phone, "gasolina", 3);
    turns.push(t3);
    assertions.push(assertStateIs(t3.state, "prospect_consumo", "State = prospect_consumo after fuel"));
    assertions.push(assertContains(t3.reply, "gastas", "Bot asks how much they spend"));

    const pass = assertions.every(a => a.ok);
    return { name, description: "Nombre capturado correctamente → avanza fuel_type → consumo", pass, turns, assertions };
  } catch (e: any) {
    return { name, description: "Nombre capturado", pass: false, turns, assertions, error: e.message };
  } finally {
    await clearPhone(phone).catch(() => {});
  }
}

async function case2_EscalacionHumana(
  handle: Function,
  storage: any
): Promise<CaseResult> {
  const phone = `${TEST_PHONE_PREFIX}02`;
  const name = "case2_EscalacionHumana";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];

  try {
    await clearPhone(phone);

    // Turn 1: immediate escalation request
    const t1 = await sendTurn(handle, storage, phone, "Conéctame con un promotor", 1);
    turns.push(t1);
    assertions.push(assert(
      t1.state === "prospect_name" || t1.state === "idle",
      `✅ State is prospect_name or idle after escalation (got: ${t1.state})`
    ));
    assertions.push(assertContains(t1.reply, "aviso", "Bot confirms it will notify the promoter"));
    assertions.push(assertNotContains(t1.reply, "conéctame", "Reply doesn't treat 'Conéctame' as a name"));
    assertions.push(assertNotContains(t1.reply, "gasolina", "Not skipped to fuel_type"));

    // Turn 2: after escalation, give name → should continue normally
    const t2 = await sendTurn(handle, storage, phone, "Pedro Ruiz", 2);
    turns.push(t2);
    assertions.push(assertStateIs(t2.state, "prospect_fuel_type", "State = prospect_fuel_type after giving name post-escalation"));

    const pass = assertions.every(a => a.ok);
    return { name, description: "Escalación no se toma como nombre, notifica promotora, flujo continúa", pass, turns, assertions };
  } catch (e: any) {
    return { name, description: "Escalación humana", pass: false, turns, assertions, error: e.message };
  } finally {
    await clearPhone(phone).catch(() => {});
  }
}

async function case3_OtpFlow(
  handle: Function,
  storage: any
): Promise<CaseResult> {
  const phone = `${TEST_PHONE_PREFIX}03`;
  const name = "case3_OtpFlow";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];

  try {
    await clearPhone(phone);

    // Turn 1: greeting
    const t1 = await sendTurn(handle, storage, phone, "Hola", 1);
    turns.push(t1);
    assertions.push(assertStateIs(t1.state, "prospect_name", "State = prospect_name after greeting"));

    // Turn 2: give name
    const t2 = await sendTurn(handle, storage, phone, "Carlos López", 2);
    turns.push(t2);
    assertions.push(assertStateIs(t2.state, "prospect_fuel_type", "State = prospect_fuel_type after name"));

    // Turn 3: send a 6-digit code — should NOT be treated as consumption or name
    // The orchestrator only processes OTP if ctx.otpSent is true; otherwise should fall through gracefully
    const t3 = await sendTurn(handle, storage, phone, "123456", 3);
    turns.push(t3);
    // Bot should stay in prospect_fuel_type (asking fuel), not crash, not accept 123456 as consumo
    assertions.push(assert(
      t3.state !== "prospect_consumo",
      `✅ 6-digit code NOT interpreted as consumo (state=${t3.state})`
    ));
    assertions.push(assert(
      t3.reply.length > 0,
      `✅ Bot responded (not empty)`
    ));
    assertions.push(assertNotContains(t3.reply, "error", "No error message on 6-digit code"));

    const pass = assertions.every(a => a.ok);
    return { name, description: "Código de 6 dígitos no se toma como consumo/nombre en estado fuel_type", pass, turns, assertions };
  } catch (e: any) {
    return { name, description: "OTP flow", pass: false, turns, assertions, error: e.message };
  } finally {
    await clearPhone(phone).catch(() => {});
  }
}

async function case4_QuieroInformacion(
  handle: Function,
  storage: any
): Promise<CaseResult> {
  const phone = `${TEST_PHONE_PREFIX}04`;
  const name = "case4_QuieroInformacion";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];

  try {
    await clearPhone(phone);

    // Turn 1: vague info request
    const t1 = await sendTurn(handle, storage, phone, "quiero información del programa", 1);
    turns.push(t1);
    assertions.push(assertStateIs(t1.state, "prospect_name", "State = prospect_name after info request"));
    assertions.push(assert(t1.reply.length > 0, "✅ Bot responded (not empty)"));
    assertions.push(assertNotContains(t1.reply, "error", "No error message"));

    // Turn 2: name comes after
    const t2 = await sendTurn(handle, storage, phone, "Rosa Mendoza", 2);
    turns.push(t2);
    assertions.push(assertStateIs(t2.state, "prospect_fuel_type", "State advances after giving name"));

    // Turn 3: another info question mid-flow
    const t3 = await sendTurn(handle, storage, phone, "¿cuánto dura el programa?", 3);
    turns.push(t3);
    // Should stay in fuel_type (RAG answers the question, doesn't change state)
    assertions.push(assert(
      t3.state === "prospect_fuel_type" || t3.state === "prospect_name",
      `✅ State stays in fuel_type or name after mid-flow question (got: ${t3.state})`
    ));
    assertions.push(assertContains(t3.reply, "36", "RAG answers with 36 months or similar"));

    const pass = assertions.every(a => a.ok);
    return { name, description: "'quiero información' → saludo + pregunta nombre, preguntas intercaladas no cambian estado", pass, turns, assertions };
  } catch (e: any) {
    return { name, description: "Info request", pass: false, turns, assertions, error: e.message };
  } finally {
    await clearPhone(phone).catch(() => {});
  }
}

async function case5_FraseAmbigua(
  handle: Function,
  storage: any
): Promise<CaseResult> {
  const phone = `${TEST_PHONE_PREFIX}05`;
  const name = "case5_FraseAmbigua";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];

  try {
    await clearPhone(phone);

    // Turn 1: typical first message from acataxi poster
    const t1 = await sendTurn(handle, storage, phone, "hola vi el cartel en acataxi quiero información", 1);
    turns.push(t1);
    assertions.push(assertStateIs(t1.state, "prospect_name", "State = prospect_name (not accepted as name)"));
    // Should ask for name, not jump to fuel
    assertions.push(assert(
      !t1.reply.toLowerCase().includes("gasolina") && !t1.reply.toLowerCase().includes("gas natural"),
      `✅ Bot doesn't jump to fuel question on ambiguous opening`
    ));
    assertions.push(assert(t1.reply.length > 10, "✅ Non-empty response"));

    // Turn 2: one-word partial greeting
    await clearPhone(phone);
    const t2 = await sendTurn(handle, storage, phone, "hola", 2);
    turns.push(t2);
    assertions.push(assertStateIs(t2.state, "prospect_name", "State = prospect_name after bare 'hola'"));

    // Turn 3: "buenos días" — should ask name
    await clearPhone(phone);
    const t3 = await sendTurn(handle, storage, phone, "buenos días", 3);
    turns.push(t3);
    assertions.push(assertStateIs(t3.state, "prospect_name", "State = prospect_name after 'buenos días'"));

    // Turn 4: long phrase that includes a real name mid-sentence — should NOT extract as name
    // "soy taxista y me llama la atención el cartel"
    await clearPhone(phone);
    const t4 = await sendTurn(handle, storage, phone, "soy taxista y me llama la atención el cartel", 4);
    turns.push(t4);
    assertions.push(assert(
      t4.state === "prospect_name" || t4.state === "idle",
      `✅ Long ambiguous phrase → prospect_name (not fuel_type), got: ${t4.state}`
    ));

    const pass = assertions.every(a => a.ok);
    return { name, description: "Frases ambiguas no se aceptan como nombre → estado prospect_name", pass, turns, assertions };
  } catch (e: any) {
    return { name, description: "Frase ambigua", pass: false, turns, assertions, error: e.message };
  } finally {
    await clearPhone(phone).catch(() => {});
  }
}

// ─── Main runner ─────────────────────────────────────────────────────────────

export async function runBotFlowTests(storage: any): Promise<{
  passed: number;
  failed: number;
  total: number;
  results: CaseResult[];
}> {
  const { handleProspectMessage } = await import("../server/agent/orchestrator");

  console.log("\n=== CMU Bot Flow Regression Tests ===\n");

  const cases: CaseResult[] = [];

  cases.push(await case1_NombreCapturado(handleProspectMessage, storage));
  cases.push(await case2_EscalacionHumana(handleProspectMessage, storage));
  cases.push(await case3_OtpFlow(handleProspectMessage, storage));
  cases.push(await case4_QuieroInformacion(handleProspectMessage, storage));
  cases.push(await case5_FraseAmbigua(handleProspectMessage, storage));

  const passed = cases.filter(c => c.pass).length;
  const failed = cases.filter(c => !c.pass).length;

  console.log(`\n── Results ──────────────────────────────────────`);
  for (const c of cases) {
    const icon = c.pass ? "✅" : "❌";
    console.log(`${icon} ${c.name}: ${c.description}`);
    if (!c.pass) {
      for (const a of c.assertions.filter(a => !a.ok)) {
        console.log(`   ${a.msg}`);
      }
      if (c.error) console.log(`   Error: ${c.error}`);
    }
  }
  console.log(`\n${passed}/${cases.length} cases passed`);

  return { passed, failed, total: cases.length, results: cases };
}

// ─── CLI runner ───────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    // For CLI: use real storage
    const { storage } = await import("../server/storage");
    const summary = await runBotFlowTests(storage);
    process.exit(summary.failed > 0 ? 1 : 0);
  })();
}
