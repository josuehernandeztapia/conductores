/**
 * director-flow-suite.ts
 * Regression tests for the DIRECTOR role (Josué) in WhatsApp.
 *
 * The director has full access: dashboard KPIs, inventory, folios, cartera,
 * market prices, evaluaciones rápidas, corridas financieras, folio creation,
 * cierre mensual, recaudo processing, sandbox mode, and OCR tool.
 *
 * CASES:
 *   D01 — Saludo: menú de comandos rápidos
 *   D02 — "números"/"dashboard": KPIs (folios activos, vehículos, disponibles)
 *   D03 — "inventario": lista de vehículos con costos y márgenes
 *   D04 — "folios": expedientes activos con status
 *   D05 — "cartera"/"mora": estado de cobranza
 *   D06 — Evaluación rápida: "march sense 2021 165k rep 20k"
 *   D07 — "corrida march sense": simulación financiera
 *   D08 — "mercado aveo 2022": precios de mercado
 *   D09 — "nuevo folio Pedro López 4491234567": creación directa
 *   D10 — "sandbox prospecto": modo test sin datos reales
 *   D11 — Buscar folio por nombre: "datos de Miguel"
 *   D12 — Gibberish: no crash
 *
 * Run via API: POST https://cmu-originacion.fly.dev/api/test/director-flow-suite
 */

const TEST_DIR_BASE = "5219995D";

interface TurnResult { turn: number; input: string; reply: string; state: string; }
interface CaseResult {
  id: string; name: string; pass: boolean;
  turns: TurnResult[]; assertions: Array<{ ok: boolean; msg: string }>; error?: string;
}

let _p = 0, _f = 0;
function ok(c: boolean, m: string): { ok: boolean; msg: string } { if (c) _p++; else _f++; return { ok: c, msg: c ? `✅ ${m}` : `❌ ${m}` }; }
function has(r: string, n: string, l: string) { return ok(r.toLowerCase().includes(n.toLowerCase()), l); }
function hasNot(r: string, n: string, l: string) { return ok(!r.toLowerCase().includes(n.toLowerCase()), l); }

async function clearPhone(phone: string) {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL!);
  await sql`DELETE FROM conversation_states WHERE phone = ${phone}`;
}

async function sendDir(agent: any, phone: string, text: string, turn: number, oid: number | null = null): Promise<TurnResult> {
  const result = await agent.handleMessage(phone, text, "Josué", null, null, oid, "director", "Josué Hernández", []);
  const { getSession } = await import("../server/conversation-state");
  const s = await getSession(phone);
  return { turn, input: text, reply: result.reply, state: s.state || "idle" };
}

// ─── D01: Saludo ───────────────────────────────────────────────────────────

async function D01_Saludo(agent: any): Promise<CaseResult> {
  const phone = `${TEST_DIR_BASE}01`;
  const id = "D01", name = "Saludo — menú de comandos rápidos";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    const t = await sendDir(agent, phone, "hola", 1);
    turns.push(t);
    a.push(has(t.reply, "números", "Shows 'números' command"));
    a.push(has(t.reply, "inventario", "Shows 'inventario' command"));
    a.push(has(t.reply, "folios", "Shows 'folios' command"));
    a.push(has(t.reply, "mercado", "Shows 'mercado' command"));
    a.push(has(t.reply, "corrida", "Shows 'corrida' command"));
    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) { return { id, name, pass: false, turns, assertions: a, error: e.message }; }
  finally { await clearPhone(phone).catch(() => {}); }
}

// ─── D02: Dashboard KPIs ───────────────────────────────────────────────────

async function D02_Dashboard(agent: any): Promise<CaseResult> {
  const phone = `${TEST_DIR_BASE}02`;
  const id = "D02", name = "'números' — dashboard KPIs";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    const t = await sendDir(agent, phone, "números", 1);
    turns.push(t);
    a.push(has(t.reply, "DASHBOARD", "Contains DASHBOARD heading"));
    a.push(has(t.reply, "Folios", "Shows folios count"));
    a.push(has(t.reply, "Vehículos", "Shows vehicles count"));
    a.push(has(t.reply, "Disponibles", "Shows available count"));
    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) { return { id, name, pass: false, turns, assertions: a, error: e.message }; }
  finally { await clearPhone(phone).catch(() => {}); }
}

// ─── D03: Inventario ───────────────────────────────────────────────────────

async function D03_Inventario(agent: any): Promise<CaseResult> {
  const phone = `${TEST_DIR_BASE}03`;
  const id = "D03", name = "'inventario' — vehículos con costos y márgenes";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    const t = await sendDir(agent, phone, "inventario", 1);
    turns.push(t);
    a.push(has(t.reply, "INVENTARIO", "Contains INVENTARIO heading"));
    a.push(ok(t.reply.includes("$"), "Contains price with $ sign"));
    a.push(ok(
      t.reply.toLowerCase().includes("march") || t.reply.toLowerCase().includes("aveo") ||
      t.reply.toLowerCase().includes("kwid"),
      "Lists at least one vehicle model"
    ));
    a.push(has(t.reply, "Margen", "Shows margin"));
    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) { return { id, name, pass: false, turns, assertions: a, error: e.message }; }
  finally { await clearPhone(phone).catch(() => {}); }
}

// ─── D04: Folios ───────────────────────────────────────────────────────────

async function D04_Folios(agent: any): Promise<CaseResult> {
  const phone = `${TEST_DIR_BASE}04`;
  const id = "D04", name = "'folios' — expedientes activos";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    const t = await sendDir(agent, phone, "folios", 1);
    turns.push(t);
    a.push(ok(t.reply.includes("CMU") || t.reply.toLowerCase().includes("folio"), "Lists folios"));
    a.push(ok(t.reply.length > 30, "Non-trivial response"));
    a.push(hasNot(t.reply, "error del sistema", "No crash"));
    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) { return { id, name, pass: false, turns, assertions: a, error: e.message }; }
  finally { await clearPhone(phone).catch(() => {}); }
}

// ─── D05: Cartera/Mora ─────────────────────────────────────────────────────

async function D05_Cartera(agent: any): Promise<CaseResult> {
  const phone = `${TEST_DIR_BASE}05`;
  const id = "D05", name = "'cartera' — estado de cobranza";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    const t = await sendDir(agent, phone, "cartera", 1);
    turns.push(t);
    a.push(ok(t.reply.length > 20, "Non-trivial response"));
    a.push(hasNot(t.reply, "error del sistema", "No crash"));
    // May show "no hay créditos" or actual cartera — both are valid
    a.push(ok(
      t.reply.toLowerCase().includes("cartera") || t.reply.toLowerCase().includes("crédito") ||
      t.reply.toLowerCase().includes("mora") || t.reply.toLowerCase().includes("no hay") ||
      t.reply.toLowerCase().includes("cobr") || t.reply.includes("$"),
      "Response relates to cartera/cobranza"
    ));
    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) { return { id, name, pass: false, turns, assertions: a, error: e.message }; }
  finally { await clearPhone(phone).catch(() => {}); }
}

// ─── D06: Evaluación rápida ────────────────────────────────────────────────

async function D06_EvalRapida(agent: any): Promise<CaseResult> {
  const phone = `${TEST_DIR_BASE}06`;
  const id = "D06", name = "Eval rápida: 'march sense 2021 165k rep 20k'";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    const t = await sendDir(agent, phone, "march sense 2021 165k rep 20k", 1);
    turns.push(t);
    a.push(ok(t.reply.includes("$"), "Contains pricing"));
    a.push(ok(
      t.reply.toLowerCase().includes("march") || t.reply.toLowerCase().includes("sense"),
      "References the model"
    ));
    a.push(ok(
      t.reply.toLowerCase().includes("negocio") || t.reply.toLowerCase().includes("margen") ||
      t.reply.toLowerCase().includes("tir") || t.reply.toLowerCase().includes("evalua") ||
      t.reply.toLowerCase().includes("cmu") || t.reply.toLowerCase().includes("pv"),
      "Contains evaluation result (negocio/margen/TIR/CMU/PV)"
    ));
    a.push(hasNot(t.reply, "error del sistema", "No crash"));
    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) { return { id, name, pass: false, turns, assertions: a, error: e.message }; }
  finally { await clearPhone(phone).catch(() => {}); }
}

// ─── D07: Corrida financiera ───────────────────────────────────────────────

async function D07_Corrida(agent: any): Promise<CaseResult> {
  const phone = `${TEST_DIR_BASE}07`;
  const id = "D07", name = "'corrida march sense' — simulación financiera";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    const t = await sendDir(agent, phone, "corrida march sense", 1);
    turns.push(t);
    a.push(ok(t.reply.length > 50, "Non-trivial response"));
    a.push(ok(
      t.reply.includes("$") || t.reply.toLowerCase().includes("cuota") ||
      t.reply.toLowerCase().includes("mes") || t.reply.toLowerCase().includes("march"),
      "Contains financial simulation data"
    ));
    a.push(hasNot(t.reply, "error del sistema", "No crash"));
    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) { return { id, name, pass: false, turns, assertions: a, error: e.message }; }
  finally { await clearPhone(phone).catch(() => {}); }
}

// ─── D08: Precios de mercado ───────────────────────────────────────────────

async function D08_Mercado(agent: any): Promise<CaseResult> {
  const phone = `${TEST_DIR_BASE}08`;
  const id = "D08", name = "'mercado aveo 2022' — precios de mercado";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    const t = await sendDir(agent, phone, "mercado aveo 2022", 1);
    turns.push(t);
    a.push(ok(t.reply.length > 30, "Non-trivial response"));
    a.push(ok(
      t.reply.includes("$") || t.reply.toLowerCase().includes("aveo") ||
      t.reply.toLowerCase().includes("precio") || t.reply.toLowerCase().includes("mercado"),
      "Contains market price info for Aveo"
    ));
    a.push(hasNot(t.reply, "error del sistema", "No crash"));
    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) { return { id, name, pass: false, turns, assertions: a, error: e.message }; }
  finally { await clearPhone(phone).catch(() => {}); }
}

// ─── D09: Crear folio directo ──────────────────────────────────────────────

async function D09_NuevoFolio(agent: any): Promise<CaseResult> {
  const phone = `${TEST_DIR_BASE}09`;
  const id = "D09", name = "'nuevo folio Pedro López 4491234567'";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    const t = await sendDir(agent, phone, "nuevo folio Ramiro Díaz 4497778899", 1);
    turns.push(t);
    a.push(ok(
      t.reply.toLowerCase().includes("folio") || t.reply.includes("CMU") ||
      t.reply.toLowerCase().includes("creado") || t.reply.toLowerCase().includes("ramiro"),
      "Folio created or name/phone requested"
    ));
    a.push(hasNot(t.reply, "error del sistema", "No crash"));
    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) { return { id, name, pass: false, turns, assertions: a, error: e.message }; }
  finally { await clearPhone(phone).catch(() => {}); }
}

// ─── D10: Sandbox mode ─────────────────────────────────────────────────────

async function D10_Sandbox(agent: any): Promise<CaseResult> {
  const phone = `${TEST_DIR_BASE}10`;
  const id = "D10", name = "'sandbox prospecto' — modo test";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    const t = await sendDir(agent, phone, "sandbox prospecto", 1);
    turns.push(t);
    a.push(ok(
      t.reply.toLowerCase().includes("sandbox") || t.reply.toLowerCase().includes("test") ||
      t.reply.toLowerCase().includes("modo") || t.reply.toLowerCase().includes("flujo"),
      "Activates sandbox mode"
    ));
    a.push(hasNot(t.reply, "error del sistema", "No crash"));
    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) { return { id, name, pass: false, turns, assertions: a, error: e.message }; }
  finally { await clearPhone(phone).catch(() => {}); }
}

// ─── D11: Buscar folio por nombre ──────────────────────────────────────────

async function D11_BuscarFolio(agent: any): Promise<CaseResult> {
  const phone = `${TEST_DIR_BASE}11`;
  const id = "D11", name = "Buscar folio por nombre — 'datos de Miguel'";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    const t = await sendDir(agent, phone, "datos de Miguel", 1);
    turns.push(t);
    a.push(ok(t.reply.length > 10, "Bot responds"));
    a.push(ok(
      t.reply.toLowerCase().includes("miguel") || t.reply.toLowerCase().includes("folio") ||
      t.reply.toLowerCase().includes("cmu") || t.reply.toLowerCase().includes("encontr"),
      "Response references Miguel or folio search"
    ));
    a.push(hasNot(t.reply, "error del sistema", "No crash"));
    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) { return { id, name, pass: false, turns, assertions: a, error: e.message }; }
  finally { await clearPhone(phone).catch(() => {}); }
}

// ─── D12: Gibberish ────────────────────────────────────────────────────────

async function D12_Gibberish(agent: any): Promise<CaseResult> {
  const phone = `${TEST_DIR_BASE}12`;
  const id = "D12", name = "Mensaje sin sentido — no crash";
  const a: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);
    const t = await sendDir(agent, phone, "zzzxxx123 ??? 🎭", 1);
    turns.push(t);
    a.push(ok(t.reply.length > 0, "Bot responds"));
    a.push(hasNot(t.reply, "error del sistema", "No system error"));
    a.push(hasNot(t.reply, "undefined", "No 'undefined' in reply"));
    return { id, name, pass: a.every(x => x.ok), turns, assertions: a };
  } catch (e: any) { return { id, name, pass: false, turns, assertions: a, error: e.message }; }
  finally { await clearPhone(phone).catch(() => {}); }
}

// ─── Main runner ─────────────────────────────────────────────────────────────

export async function runDirectorFlowSuite(storage: any, whatsappAgent: any): Promise<{
  passed: number; failed: number; total: number; results: CaseResult[];
}> {
  _p = 0; _f = 0;
  console.log("\n=== CMU Director Flow Suite (12 cases) ===\n");

  const cases: CaseResult[] = [
    await D01_Saludo(whatsappAgent),
    await D02_Dashboard(whatsappAgent),
    await D03_Inventario(whatsappAgent),
    await D04_Folios(whatsappAgent),
    await D05_Cartera(whatsappAgent),
    await D06_EvalRapida(whatsappAgent),
    await D07_Corrida(whatsappAgent),
    await D08_Mercado(whatsappAgent),
    await D09_NuevoFolio(whatsappAgent),
    await D10_Sandbox(whatsappAgent),
    await D11_BuscarFolio(whatsappAgent),
    await D12_Gibberish(whatsappAgent),
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
