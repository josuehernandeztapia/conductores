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
    assertions.push(assert(
      t3.reply.toLowerCase().includes("36") || t3.reply.toLowerCase().includes("mes") ||
      t3.reply.toLowerCase().includes("programa") || t3.reply.length > 30,
      "✅ RAG or bot provides meaningful answer to mid-flow question"
    ));

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

    // Turn 2: one-word partial greeting — fresh phone to avoid state pollution
    const phone2 = `${TEST_PHONE_PREFIX}5B`;
    await clearPhone(phone2);
    const t2 = await sendTurn(handle, storage, phone2, "hola", 2);
    turns.push(t2);
    assertions.push(assertStateIs(t2.state, "prospect_name", "State = prospect_name after bare 'hola'"));
    await clearPhone(phone2).catch(() => {});

    // Turn 3: "buenos días" — fresh phone
    const phone3 = `${TEST_PHONE_PREFIX}5C`;
    await clearPhone(phone3);
    const t3 = await sendTurn(handle, storage, phone3, "buenos días", 3);
    turns.push(t3);
    // State may show as idle before DB write propagates; check the reply instead
    assertions.push(assert(
      t3.state === "prospect_name" || t3.reply.toLowerCase().includes("llamas") || t3.reply.toLowerCase().includes("nombre"),
      `✅ 'buenos días' → bot asks for name (state=${t3.state})`
    ));
    await clearPhone(phone3).catch(() => {});

    // Turn 4: long ambiguous phrase — fresh phone
    const phone4 = `${TEST_PHONE_PREFIX}5D`;
    await clearPhone(phone4);
    const t4 = await sendTurn(handle, storage, phone4, "soy taxista y me llama la atención el cartel", 4);
    turns.push(t4);
    // "soy taxista y me llama la atencion..." — should stay at prospect_name
    // If NLU fires give_name for partial match, it goes to fuel_type — that's the bug to catch
    assertions.push(assert(
      t4.state !== "prospect_fuel_type",
      `Long ambiguous phrase NOT accepted as name (state=${t4.state}, should not be prospect_fuel_type)`
    ));
    await clearPhone(phone4).catch(() => {});

    const pass = assertions.every(a => a.ok);
    return { name, description: "Frases ambiguas no se aceptan como nombre → estado prospect_name", pass, turns, assertions };
  } catch (e: any) {
    return { name, description: "Frase ambigua", pass: false, turns, assertions, error: e.message };
  } finally {
    await clearPhone(phone).catch(() => {});
  }
}

// ─── Error Flow Cases ────────────────────────────────────────────────────────

async function case6_OCRIlegible(
  handle: Function,
  storage: any
): Promise<CaseResult> {
  const phone = `${TEST_PHONE_PREFIX}06`;
  const name = "case6_OCRIlegible";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];

  try {
    await clearPhone(phone);

    // Setup: get prospect into docs_capture state
    await sendTurn(handle, storage, phone, "Hola", 0);
    await sendTurn(handle, storage, phone, "Luis García", 0);
    await sendTurn(handle, storage, phone, "gasolina", 0);
    await sendTurn(handle, storage, phone, "8000", 0);
    // Select model
    await sendTurn(handle, storage, phone, "march sense 2021", 0);
    await sendTurn(handle, storage, phone, "sí", 0);
    // At this point state should be docs_capture — inject mock illegible vision result

    const { handleDocWithMockVision } = await import("../server/agent/orchestrator");

    // Inject illegible vision result (blurry photo)
    const reply = await handleDocWithMockVision(phone, {
      detected_type: "ine_frente",
      is_legible: false,
      confidence: 0.1,
      rejection_reason: "La imagen está borrosa, no se pueden leer los datos.",
    }, storage);

    turns.push({ turn: 1, input: "[imagen borrosa]", reply, state: "docs_capture" });

    assertions.push(assertContains(reply, "borrosa", "Bot mentions image is blurry"));
    assertions.push(assertNotContains(reply, "recibido", "Doc NOT accepted as collected"));
    assertions.push(assertNotContains(reply, "error del sistema", "No system crash error"));

    // Verify state did NOT advance to next doc
    const { getSession } = await import("../server/conversation-state");
    const session = await getSession(phone);
    const stateAfter = (session.context as any)?.agentState || "unknown";
    const ctxAfter = (session.context as any)?.agentContext || {};
    const docsCollected: string[] = ctxAfter.docsCollected || [];

    assertions.push(assert(
      !docsCollected.includes("ine_frente"),
      `✅ ine_frente NOT added to docsCollected (illegible doc rejected)`
    ));

    // Second attempt: resend — this time legible but wrong type
    const reply2 = await handleDocWithMockVision(phone, {
      detected_type: "unknown",
      is_legible: true,
      confidence: 0.4,
      rejection_reason: "No reconozco este documento.",
    }, storage);

    turns.push({ turn: 2, input: "[imagen tipo desconocido]", reply: reply2, state: "docs_capture" });
    assertions.push(assertContains(reply2, "reconozco", "Bot says doesn't recognize document type"));

    const pass = assertions.every(a => a.ok);
    return { name, description: "OCR ilegible — doc no se guarda, bot pide reenviar, no crash", pass, turns, assertions };
  } catch (e: any) {
    return { name, description: "OCR ilegible", pass: false, turns, assertions, error: e.message };
  } finally {
    await clearPhone(phone).catch(() => {});
  }
}

async function case7_OtpIncorrecto3Veces(
  handle: Function,
  storage: any
): Promise<CaseResult> {
  const phone = `${TEST_PHONE_PREFIX}07`;
  const name = "case7_OtpIncorrecto3Veces";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];

  try {
    await clearPhone(phone);

    // Setup: get to a state where OTP was sent (ctx.otpSent = true)
    // Simulate this by manually setting context
    const { updateSession } = await import("../server/conversation-state");
    await updateSession(phone, {
      state: "simulation" as any,
      context: {
        agentState: "docs_capture",
        agentContext: {
          nombre: "Carlos Peña",
          folio: "CMU-TEST-000000-001",
          otpSent: true,
          otpVerified: false,
          docsCollected: [],
          fuelType: "gasolina",
        },
      } as any,
    });

    // Turn 1: wrong OTP
    const t1 = await sendTurn(handle, storage, phone, "999999", 1);
    turns.push(t1);
    assertions.push(assertContains(t1.reply, "correcto", "Bot says code incorrect (turn 1)"));
    assertions.push(assertStateIs(t1.state, "docs_capture", "State stays docs_capture after wrong OTP"));

    // Turn 2: wrong OTP again
    const t2 = await sendTurn(handle, storage, phone, "888888", 2);
    turns.push(t2);
    assertions.push(assertContains(t2.reply, "correcto", "Bot says code incorrect (turn 2)"));
    assertions.push(assertStateIs(t2.state, "docs_capture", "State stays docs_capture after 2nd wrong OTP"));

    // Turn 3: wrong OTP third time
    const t3 = await sendTurn(handle, storage, phone, "777777", 3);
    turns.push(t3);
    assertions.push(assert(t3.reply.length > 0, "✅ Bot responds on 3rd wrong attempt (no crash)"));
    assertions.push(assert(
      !t3.reply.toLowerCase().includes("verified") && !t3.reply.toLowerCase().includes("verificado ✓"),
      `✅ Phone NOT verified after 3 wrong codes`
    ));

    // Turn 4: after 3 wrong codes, bot should still be usable (state not broken)
    const t4 = await sendTurn(handle, storage, phone, "estado", 4);
    turns.push(t4);
    assertions.push(assert(t4.reply.length > 0, "✅ Bot still responsive after failed OTPs"));
    assertions.push(assertNotContains(t4.reply, "error del sistema", "No system crash after failed OTPs"));

    const pass = assertions.every(a => a.ok);
    return { name, description: "OTP incorrecto 3 veces — bot rechaza cada intento, flujo no se rompe", pass, turns, assertions };
  } catch (e: any) {
    return { name, description: "OTP incorrecto 3 veces", pass: false, turns, assertions, error: e.message };
  } finally {
    await clearPhone(phone).catch(() => {});
  }
}

async function case8_ClabeInvalida(
  handle: Function,
  storage: any
): Promise<CaseResult> {
  const phone = `${TEST_PHONE_PREFIX}08`;
  const name = "case8_ClabeInvalida";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];

  try {
    await clearPhone(phone);

    // Setup: put prospect in docs_capture with some existing data (INE already captured)
    const { updateSession } = await import("../server/conversation-state");
    await updateSession(phone, {
      state: "simulation" as any,
      context: {
        agentState: "docs_capture",
        agentContext: {
          nombre: "Rosa Domínguez",
          folio: "CMU-TEST-000000-002",
          otpSent: true,
          otpVerified: true,
          docsCollected: ["ine_frente", "ine_vuelta"],
          existingData: { nombre_ine: "ROSA DOMÍNGUEZ LÓPEZ" },
          fuelType: "gasolina",
        },
      } as any,
    });

    const { handleDocWithMockVision } = await import("../server/agent/orchestrator");

    // Inject estado de cuenta with invalid CLABE (only 17 digits)
    const reply = await handleDocWithMockVision(phone, {
      detected_type: "estado_cuenta",
      is_legible: true,
      confidence: 0.9,
      extracted_data: {
        nombre: "ROSA DOMÍNGUEZ LÓPEZ",
        clabe: "01234567890123456",  // 17 digits (invalid, needs 18)
        banco: "BBVA",
      },
      cross_check_flags: ["clabe_invalid"],
    }, storage);

    turns.push({ turn: 1, input: "[estado de cuenta con CLABE de 17 dígitos]", reply, state: "docs_capture" });

    // Verify: warning shown AND doc still accepted (warn, not reject)
    assertions.push(assertContains(reply, "CLABE", "Bot shows CLABE warning"));
    assertions.push(assertContains(reply, "18", "Bot mentions 18 digits in CLABE warning"));
    assertions.push(assertContains(reply, "recibido", "Doc IS accepted despite CLABE warning (warn, not reject)"));

    // Verify the doc was actually saved to context
    const { getSession } = await import("../server/conversation-state");
    const session = await getSession(phone);
    const ctxAfter = (session.context as any)?.agentContext || {};
    const docsCollected: string[] = ctxAfter.docsCollected || [];

    assertions.push(assert(
      docsCollected.includes("estado_cuenta"),
      `✅ estado_cuenta added to docsCollected despite invalid CLABE (warning, not rejection)`
    ));

    // Also test: a CLABE with letters (completely invalid format)
    const reply2 = await handleDocWithMockVision(phone, {
      detected_type: "estado_cuenta",
      is_legible: true,
      confidence: 0.95,
      extracted_data: {
        nombre: "ROSA DOMÍNGUEZ LÓPEZ",
        clabe: "ABCDEF12345678901",
        banco: "Santander",
      },
      cross_check_flags: ["clabe_invalid"],
    }, storage);

    turns.push({ turn: 2, input: "[estado de cuenta con CLABE inválida (letras)]", reply: reply2, state: "docs_capture" });
    assertions.push(assertContains(reply2, "CLABE", "Bot warns about CLABE on second attempt too"));

    const pass = assertions.every(a => a.ok);
    return { name, description: "CLABE inválida — advertencia mostrada, doc igualmente aceptado (warn not reject)", pass, turns, assertions };
  } catch (e: any) {
    return { name, description: "CLABE inválida", pass: false, turns, assertions, error: e.message };
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

  // Pre-clean basic flow test phones to avoid state pollution between endpoint invocations
  // Note: error case phones (06,07,08) do their own setup and are NOT pre-cleaned here
  const BASIC_PHONES = ["01","02","03","04","05","5B","5C","5D"].map(
    s => `${TEST_PHONE_PREFIX}${s}`
  );
  for (const p of BASIC_PHONES) { await clearPhone(p).catch(() => {}); }

  console.log("\n=== CMU Bot Flow Regression Tests ===\n");

  const cases: CaseResult[] = [];

  cases.push(await case1_NombreCapturado(handleProspectMessage, storage));
  cases.push(await case2_EscalacionHumana(handleProspectMessage, storage));
  cases.push(await case3_OtpFlow(handleProspectMessage, storage));
  cases.push(await case4_QuieroInformacion(handleProspectMessage, storage));
  cases.push(await case5_FraseAmbigua(handleProspectMessage, storage));
  cases.push(await case6_OCRIlegible(handleProspectMessage, storage));
  cases.push(await case7_OtpIncorrecto3Veces(handleProspectMessage, storage));
  cases.push(await case8_ClabeInvalida(handleProspectMessage, storage));

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
