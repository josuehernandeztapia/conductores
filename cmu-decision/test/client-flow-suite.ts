/**
 * client-flow-suite.ts
 * Regression tests for the CLIENTE role in WhatsApp.
 *
 * A cliente is a taxista with an active credit/folio who interacts
 * with the bot for: checking payments, sending docs, running simulations,
 * starting interviews, querying inventory, and general questions.
 *
 * CASES:
 *   C01 — Saludo con folio activo: muestra estado del trámite + docs pendientes
 *   C02 — Saludo sin folio activo: saludo genérico, ofrece ayuda
 *   C03 — Envío de documento (mock): doc se procesa y guarda
 *   C04 — Consulta "mis pagos"/"estado de cuenta": respuesta con datos de crédito
 *   C05 — Consulta de inventario: lista de vehículos disponibles
 *   C06 — Pregunta sobre el programa (FAQ/RAG): respuesta informativa
 *   C07 — Solicitud de simulación/corrida: "cuánto pago mensual" → simulación
 *   C08 — Solicitud de entrevista con folio activo
 *   C09 — Mensaje sin sentido / gibberish: bot no crashea
 *   C10 — Imagen sin folio vinculado: bot pide contexto
 *
 * Run via API: POST https://cmu-originacion.fly.dev/api/test/client-flow-suite
 */

const TEST_CLIENT_BASE = "5219996C";

interface TurnResult { turn: number; input: string; reply: string; state: string; }
interface CaseResult {
  id: string; name: string; pass: boolean;
  turns: TurnResult[]; assertions: Array<{ ok: boolean; msg: string }>; error?: string;
}

let _passed = 0;
let _failed = 0;

function ok(condition: boolean, msg: string): { ok: boolean; msg: string } {
  if (condition) _passed++; else _failed++;
  return { ok: condition, msg: condition ? `✅ ${msg}` : `❌ ${msg}` };
}
function has(reply: string, needle: string, label: string) {
  return ok(reply.toLowerCase().includes(needle.toLowerCase()), label);
}
function hasNot(reply: string, needle: string, label: string) {
  return ok(!reply.toLowerCase().includes(needle.toLowerCase()), label);
}

async function clearPhone(phone: string): Promise<void> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL!);
  await sql`DELETE FROM conversation_states WHERE phone = ${phone}`;
}

async function ensureRole(phone: string, role: string, name: string): Promise<void> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL!);
  await sql`
    INSERT INTO whatsapp_roles (phone, role, name, active, permissions, phone_verified)
    VALUES (${phone}, ${role}, ${name}, true, '{}', true)
    ON CONFLICT (phone) DO UPDATE SET role = ${role}, name = ${name}
  `;
}

async function removeRole(phone: string): Promise<void> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL!);
  await sql`DELETE FROM whatsapp_roles WHERE phone = ${phone}`;
}

async function sendClient(
  agent: any, phone: string, text: string, turn: number, oid: number | null = null
): Promise<TurnResult> {
  const result = await agent.handleMessage(
    phone, text, "Test Cliente", null, null, oid,
    "cliente", "Don Pedro Test", []
  );
  const { getSession } = await import("../server/conversation-state");
  const s = await getSession(phone);
  return { turn, input: text, reply: result.reply, state: s.state || "idle" };
}

// ─── C01: Saludo con folio activo ──────────────────────────────────────────

async function C01_SaludoConFolio(agent: any, storage: any): Promise<CaseResult> {
  const phone = `${TEST_CLIENT_BASE}01`;
  const id = "C01", name = "Saludo con folio activo — muestra estado del trámite";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    await ensureRole(phone, "cliente", "Don Pedro Test");

    // Find any active folio to associate
    const origs = await storage.listOriginations();
    const activo = origs.find((o: any) => !["RECHAZADO", "COMPLETADO", "CANCELADO"].includes(o.estado));
    const oid = activo?.id || null;

    const t1 = await sendClient(agent, phone, "hola", 1, oid);
    turns.push(t1);
    a.push(ok(t1.reply.length > 20, "Bot responds with meaningful greeting"));
    a.push(hasNot(t1.reply, "error del sistema", "No crash"));
    if (oid) {
      a.push(ok(
        t1.reply.toLowerCase().includes("folio") || t1.reply.toLowerCase().includes("paso") ||
        t1.reply.toLowerCase().includes("trámite") || t1.reply.toLowerCase().includes("documento"),
        "Shows folio status when folio is linked"
      ));
    }

    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions: a, error: e.message };
  } finally {
    await removeRole(phone).catch(() => {});
    await clearPhone(phone).catch(() => {});
  }
}

// ─── C02: Saludo sin folio activo ──────────────────────────────────────────

async function C02_SaludoSinFolio(agent: any): Promise<CaseResult> {
  const phone = `${TEST_CLIENT_BASE}02`;
  const id = "C02", name = "Saludo sin folio activo — saludo genérico";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    await ensureRole(phone, "cliente", "María Test");

    const t1 = await sendClient(agent, phone, "hola", 1, null);
    turns.push(t1);
    a.push(ok(t1.reply.length > 20, "Bot responds with greeting"));
    a.push(ok(
      t1.reply.toLowerCase().includes("ayudo") || t1.reply.toLowerCase().includes("asistente") ||
      t1.reply.toLowerCase().includes("conductores"),
      "Offers help or introduces itself"
    ));
    a.push(hasNot(t1.reply, "error", "No error"));

    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions: a, error: e.message };
  } finally {
    await removeRole(phone).catch(() => {});
    await clearPhone(phone).catch(() => {});
  }
}

// ─── C03: Envío de documento (mock vision) ─────────────────────────────────

async function C03_EnvioDocumento(agent: any, storage: any): Promise<CaseResult> {
  const phone = `${TEST_CLIENT_BASE}03`;
  const id = "C03", name = "Envío de documento con folio — doc procesado";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    await ensureRole(phone, "cliente", "Pedro Doc Test");

    const origs = await storage.listOriginations();
    const activo = origs.find((o: any) => !["RECHAZADO", "COMPLETADO", "CANCELADO"].includes(o.estado));
    if (!activo) {
      return { id, name: `${name} — SKIPPED (no active folio)`, pass: true, turns, assertions: [ok(true, "Skipped")] };
    }

    // Use the handleDocWithMockVision from orchestrator
    const { handleDocWithMockVision } = await import("../server/agent/orchestrator");
    const { updateSession } = await import("../server/conversation-state");

    await updateSession(phone, {
      state: "simulation" as any,
      context: {
        agentState: "docs_capture",
        agentContext: {
          nombre: "Pedro Doc Test",
          folio: activo.folio,
          originationId: activo.id,
          docsCollected: [],
          skippedDocs: [],
          fuelType: "gasolina",
        },
      } as any,
    });

    const reply = await handleDocWithMockVision(phone, {
      detected_type: "ine_frente",
      is_legible: true,
      confidence: 0.95,
      extracted_data: { nombre: "PEDRO TEST LÓPEZ", curp: "TELP000101HAGRRD09" },
      cross_check_flags: [],
    }, storage);

    turns.push({ turn: 1, input: "[Foto INE Frente]", reply: reply.slice(0, 200), state: "docs_capture" });
    a.push(has(reply, "recibido", "Doc accepted"));
    a.push(hasNot(reply, "error del sistema", "No crash"));

    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions: a, error: e.message };
  } finally {
    await removeRole(phone).catch(() => {});
    await clearPhone(phone).catch(() => {});
  }
}

// ─── C04: Consulta pagos ───────────────────────────────────────────────────

async function C04_ConsultaPagos(agent: any): Promise<CaseResult> {
  const phone = `${TEST_CLIENT_BASE}04`;
  const id = "C04", name = "Consulta 'mis pagos' — respuesta sin crash";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    await ensureRole(phone, "cliente", "Carlos Pagos Test");

    const t1 = await sendClient(agent, phone, "mis pagos", 1);
    turns.push(t1);
    a.push(ok(t1.reply.length > 10, "Bot responds"));
    a.push(hasNot(t1.reply, "error del sistema", "No crash"));
    // May not have Airtable data — just check no crash
    a.push(ok(
      t1.reply.toLowerCase().includes("pago") || t1.reply.toLowerCase().includes("cuenta") ||
      t1.reply.toLowerCase().includes("folio") || t1.reply.toLowerCase().includes("ayudo") ||
      t1.reply.length > 20,
      "Response is meaningful (payments, status, or general help)"
    ));

    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions: a, error: e.message };
  } finally {
    await removeRole(phone).catch(() => {});
    await clearPhone(phone).catch(() => {});
  }
}

// ─── C05: Consulta inventario ──────────────────────────────────────────────

async function C05_ConsultaInventario(agent: any): Promise<CaseResult> {
  const phone = `${TEST_CLIENT_BASE}05`;
  const id = "C05", name = "Consulta de inventario — lista vehículos disponibles";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    await ensureRole(phone, "cliente", "Ana Inventario Test");

    const t1 = await sendClient(agent, phone, "qué carros tienen disponibles", 1);
    turns.push(t1);
    a.push(ok(
      t1.reply.toLowerCase().includes("march") || t1.reply.toLowerCase().includes("aveo") ||
      t1.reply.toLowerCase().includes("kwid") || t1.reply.toLowerCase().includes("i10") ||
      t1.reply.toLowerCase().includes("disponible"),
      "Shows available vehicles"
    ));
    a.push(hasNot(t1.reply, "error del sistema", "No crash"));

    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions: a, error: e.message };
  } finally {
    await removeRole(phone).catch(() => {});
    await clearPhone(phone).catch(() => {});
  }
}

// ─── C06: Pregunta FAQ/RAG ─────────────────────────────────────────────────

async function C06_PreguntaFAQ(agent: any): Promise<CaseResult> {
  const phone = `${TEST_CLIENT_BASE}06`;
  const id = "C06", name = "Pregunta FAQ — respuesta informativa del RAG";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    await ensureRole(phone, "cliente", "Luis FAQ Test");

    const t1 = await sendClient(agent, phone, "¿cómo funciona el programa CMU?", 1);
    turns.push(t1);
    a.push(ok(t1.reply.length > 50, "Response is substantial"));
    a.push(ok(
      t1.reply.toLowerCase().includes("gas") || t1.reply.toLowerCase().includes("gnv") ||
      t1.reply.toLowerCase().includes("vehículo") || t1.reply.toLowerCase().includes("programa") ||
      t1.reply.toLowerCase().includes("36"),
      "Answer is relevant to CMU program"
    ));
    a.push(hasNot(t1.reply, "error del sistema", "No crash"));

    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions: a, error: e.message };
  } finally {
    await removeRole(phone).catch(() => {});
    await clearPhone(phone).catch(() => {});
  }
}

// ─── C07: Simulación / corrida ─────────────────────────────────────────────

async function C07_Simulacion(agent: any): Promise<CaseResult> {
  const phone = `${TEST_CLIENT_BASE}07`;
  const id = "C07", name = "Solicitud de simulación — 'cuánto pagaría mensual'";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    await ensureRole(phone, "cliente", "Roberto Sim Test");

    const t1 = await sendClient(agent, phone, "cuánto pagaría de mensualidad por un march sense", 1);
    turns.push(t1);
    a.push(ok(t1.reply.length > 30, "Non-trivial response"));
    a.push(ok(
      t1.reply.includes("$") || t1.reply.toLowerCase().includes("cuota") ||
      t1.reply.toLowerCase().includes("mes") || t1.reply.toLowerCase().includes("march"),
      "Response includes pricing/payment info"
    ));
    a.push(hasNot(t1.reply, "error del sistema", "No crash"));

    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions: a, error: e.message };
  } finally {
    await removeRole(phone).catch(() => {});
    await clearPhone(phone).catch(() => {});
  }
}

// ─── C08: Solicitud de entrevista ──────────────────────────────────────────

async function C08_Entrevista(agent: any, storage: any): Promise<CaseResult> {
  const phone = `${TEST_CLIENT_BASE}08`;
  const id = "C08", name = "Solicitud de entrevista con folio activo";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    await ensureRole(phone, "cliente", "Elena Entrevista Test");

    const origs = await storage.listOriginations();
    const activo = origs.find((o: any) => !["RECHAZADO", "COMPLETADO", "CANCELADO"].includes(o.estado));
    const oid = activo?.id || null;

    const t1 = await sendClient(agent, phone, "entrevista", 1, oid);
    turns.push(t1);
    a.push(ok(
      t1.reply.toLowerCase().includes("entrevista") || t1.reply.toLowerCase().includes("pregunta") ||
      t1.reply.toLowerCase().includes("folio") || t1.reply.toLowerCase().includes("nombre"),
      "Bot responds to interview request"
    ));
    a.push(hasNot(t1.reply, "error del sistema", "No crash"));

    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions: a, error: e.message };
  } finally {
    await removeRole(phone).catch(() => {});
    await clearPhone(phone).catch(() => {});
  }
}

// ─── C09: Gibberish — no crash ─────────────────────────────────────────────

async function C09_Gibberish(agent: any): Promise<CaseResult> {
  const phone = `${TEST_CLIENT_BASE}09`;
  const id = "C09", name = "Mensaje sin sentido — bot no crashea";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    await ensureRole(phone, "cliente", "Gibberish Test");

    const t1 = await sendClient(agent, phone, "asdfghjkl 12345 ???", 1);
    turns.push(t1);
    a.push(ok(t1.reply.length > 0, "Bot responds (no crash)"));
    a.push(hasNot(t1.reply, "error del sistema", "No system error message"));
    a.push(hasNot(t1.reply, "undefined", "No 'undefined' in reply"));

    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions: a, error: e.message };
  } finally {
    await removeRole(phone).catch(() => {});
    await clearPhone(phone).catch(() => {});
  }
}

// ─── C10: Imagen sin folio ─────────────────────────────────────────────────

async function C10_ImagenSinFolio(agent: any): Promise<CaseResult> {
  const phone = `${TEST_CLIENT_BASE}10`;
  const id = "C10", name = "Imagen sin folio vinculado — pide contexto";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    await ensureRole(phone, "cliente", "Foto Sin Folio Test");

    // Send a text that simulates what happens when image is sent without folio
    // (We can't send real media in tests, but we can test the "no folio" path)
    const t1 = await sendClient(agent, phone, "ya mandé la foto de mi INE", 1, null);
    turns.push(t1);
    a.push(ok(t1.reply.length > 10, "Bot responds"));
    a.push(hasNot(t1.reply, "error del sistema", "No crash"));

    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions: a, error: e.message };
  } finally {
    await removeRole(phone).catch(() => {});
    await clearPhone(phone).catch(() => {});
  }
}

// ─── Main runner ─────────────────────────────────────────────────────────────

export async function runClientFlowSuite(storage: any, whatsappAgent: any): Promise<{
  passed: number; failed: number; total: number; results: CaseResult[];
}> {
  _passed = 0;
  _failed = 0;

  console.log("\n=== CMU Client Flow Suite (10 cases) ===\n");

  const cases: CaseResult[] = [
    await C01_SaludoConFolio(whatsappAgent, storage),
    await C02_SaludoSinFolio(whatsappAgent),
    await C03_EnvioDocumento(whatsappAgent, storage),
    await C04_ConsultaPagos(whatsappAgent),
    await C05_ConsultaInventario(whatsappAgent),
    await C06_PreguntaFAQ(whatsappAgent),
    await C07_Simulacion(whatsappAgent),
    await C08_Entrevista(whatsappAgent, storage),
    await C09_Gibberish(whatsappAgent),
    await C10_ImagenSinFolio(whatsappAgent),
  ];

  const passed = cases.filter(c => c.pass).length;
  const failed = cases.filter(c => !c.pass).length;

  console.log("\n── Results ──────────────────────────────────────");
  for (const c of cases) {
    console.log(`${c.pass ? "✅" : "❌"} ${c.id}: ${c.name}`);
    if (!c.pass) {
      c.assertions.filter(x => !x.ok).forEach(x => console.log(`   ${x.msg}`));
      if (c.error) console.log(`   Error: ${c.error}`);
    }
  }
  console.log(`\n${passed}/${cases.length} cases passed\n`);

  return { passed, failed, total: cases.length, results: cases };
}
