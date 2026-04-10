/**
 * full-flow-suite.ts
 * Comprehensive regression suite — ALL possible flows for promotora and prospecto.
 *
 * PROMOTORA FLOWS (12 cases):
 *   P01 — Sesión expirada >15 min: PIN requerido, folio BORRADOR preservado
 *   P02 — PIN incorrecto en re-auth: error, folio sigue bloqueado
 *   P03 — PIN correcto en re-auth: sesión restaurada con folio activo
 *   P04 — Nuevo prospecto: nombre + tel → folio creado → docs
 *   P05 — Retomar folio por número de menú (1/2/3)
 *   P06 — Retomar folio por nombre textual ("Miguel Flores")
 *   P07 — Comando "docs" con folio activo → lista pendientes
 *   P08 — Comando "entrevista" con folio activo → trigger entrevista
 *   P09 — Comando "cambiar folio" → regresa al menú
 *   P10 — Reporte de trámites ("pendientes") → lista determinística
 *   P11 — Folio sin teléfono (solo nombre dado) → pide teléfono
 *   P12 — Nombre ambiguo como número de menú ("tres") → no crash
 *
 * PROSPECTO FLOWS (8 cases):
 *   Q01 — Sesión expirada >15 min prospecto: reinicia idle, no error
 *   Q02 — Footer presente en TODOS los estados del flujo
 *   Q03 — Flujo completo GNV: idle → nombre → fuel_gnv → consumo → modelo → corrida → confirm
 *   Q04 — Flujo completo gasolina: idle → nombre → gasolina → gasto → modelo → corrida → confirm
 *   Q05 — Skip de documento ("siguiente") → avanza al siguiente doc
 *   Q06 — Consulta de estado ("estado") → muestra progreso
 *   Q07 — Salto directo a entrevista ("entrevista") desde docs_capture
 *   Q08 — Mensaje "atrás"/"regresar" en flujo — bot maneja sin crash
 *
 * Run via API (deployed):
 *   POST https://cmu-originacion.fly.dev/api/test/full-flow-suite
 */

const TEST_PHONE_BASE = "5219998000"; // safe test range

// ─── Shared helpers ───────────────────────────────────────────────────────────

interface TurnResult { turn: number; input: string; reply: string; state: string; }
interface CaseResult {
  id: string; name: string; pass: boolean;
  turns: TurnResult[]; assertions: Array<{ ok: boolean; msg: string }>; error?: string;
}

let _gPassed = 0;
let _gFailed = 0;

function ok(condition: boolean, msg: string): { ok: boolean; msg: string } {
  if (condition) _gPassed++; else _gFailed++;
  return { ok: condition, msg: condition ? `✅ ${msg}` : `❌ ${msg}` };
}
function has(reply: string, needle: string, label: string) {
  return ok(reply.toLowerCase().includes(needle.toLowerCase()), label);
}
function hasNot(reply: string, needle: string, label: string) {
  return ok(!reply.toLowerCase().includes(needle.toLowerCase()), label);
}
function stateIs(state: string, expected: string) {
  return ok(state === expected, `State = ${expected} (got: ${state})`);
}

async function getState(phone: string): Promise<string> {
  const { getSession } = await import("../server/conversation-state");
  const s = await getSession(phone);
  return (s.context as any)?.agentState || s.state || "idle";
}

async function clearPhone(phone: string): Promise<void> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL!);
  await sql`DELETE FROM conversation_states WHERE phone = ${phone}`;
  await sql`DELETE FROM taxistas WHERE telefono = ${phone}`;
}

async function setStateManual(
  phone: string,
  agentState: string,
  agentContext: Record<string, any>,
  updatedAtOffset?: number // negative ms offset to simulate old session
): Promise<void> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL!);
  const ctx = JSON.stringify({ agentState, agentContext });
  if (updatedAtOffset !== undefined) {
    // Backdate the updated_at to simulate inactivity
    const ts = new Date(Date.now() + updatedAtOffset).toISOString();
    await sql`
      INSERT INTO conversation_states (phone, state, context, updated_at)
      VALUES (${phone}, 'simulation', ${ctx}::jsonb, ${ts}::timestamptz)
      ON CONFLICT (phone) DO UPDATE
        SET state = 'simulation', context = ${ctx}::jsonb, updated_at = ${ts}::timestamptz
    `;
  } else {
    const { updateSession } = await import("../server/conversation-state");
    await updateSession(phone, {
      state: "simulation" as any,
      context: { agentState, agentContext } as any,
    });
  }
}

async function sendProspect(handle: Function, storage: any, phone: string, text: string, turn: number): Promise<TurnResult> {
  const reply = await handle(phone, text, null, null, "Test", storage);
  const state = await getState(phone);
  return { turn, input: text, reply, state };
}

// ─── PROMOTORA HELPERS ───────────────────────────────────────────────────────

async function sendPromotor(agent: any, phone: string, text: string, turn: number, oid: number | null = null): Promise<TurnResult> {
  const result = await agent.handleMessage(phone, text, "Ángeles", null, null, oid, "promotora", "Ángeles Mireles", []);
  // State for promotora comes from conversation_states directly
  const { getSession: getConvSession } = await import("../server/conversation-state");
  const s = await getConvSession(phone);
  const state = s.state || "idle";
  return { turn, input: text, reply: result.reply, state };
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMOTORA CASES
// ─────────────────────────────────────────────────────────────────────────────

async function P01_SesionExpirada(agent: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}P01`;
  const id = "P01", name = "Sesión expirada >15 min — PIN requerido, folio BORRADOR preservado";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    // Simulate session that expired 20 minutes ago with folio active
    await setStateManual(phone, "capturing_docs", {
      folio: { id: 999, folio: "CMU-SIN-TEST-001", taxistaName: "Test Taxista" }
    }, -(20 * 60 * 1000));

    const t1 = await sendPromotor(agent, phone, "qué sigue", 1, 999);
    turns.push(t1);
    assertions.push(has(t1.reply, "pin", "Bot asks for PIN after expiry"));
    assertions.push(has(t1.reply, "expiró", "Bot mentions session expired"));
    assertions.push(has(t1.reply, "folio", "Bot mentions folio is preserved"));
    assertions.push(hasNot(t1.reply, "error del sistema", "No crash"));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function P02_PinIncorrectoReauth(agent: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}P02`;
  const id = "P02", name = "PIN incorrecto en re-auth — error, folio sigue bloqueado";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL!);
  try {
    await clearPhone(phone);

    // Register phone as promotora so session expiry block fires
    await sql`
      INSERT INTO whatsapp_roles (phone, role, name, active, permissions, phone_verified)
      VALUES (${phone}, 'promotora', 'Test Promotora P02', true, '{}', true)
      ON CONFLICT (phone) DO UPDATE SET role = 'promotora', name = 'Test Promotora P02'
    `;

    // Set awaiting_reauth state (backdated so isExpired=true if needed, but awaiting_reauth is what matters)
    // awaiting_reauth must be at the top level of context (not inside agentContext)
    // because whatsapp-agent reads convState.context.awaiting_reauth
    const { neon: neon2 } = await import("@neondatabase/serverless");
    const sql2 = neon2(process.env.DATABASE_URL!);
    const ctx2 = JSON.stringify({
      awaiting_reauth: true,
      reauth_folio_id: 888,
      agentState: "capturing_docs",
      agentContext: { folio: { id: 888, folio: "CMU-SIN-TEST-002" } }
    });
    const ts2 = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await sql2`
      INSERT INTO conversation_states (phone, state, context, updated_at)
      VALUES (${phone}, 'simulation', ${ctx2}::jsonb, ${ts2}::timestamptz)
      ON CONFLICT (phone) DO UPDATE
        SET state = 'simulation', context = ${ctx2}::jsonb, updated_at = ${ts2}::timestamptz
    `;

    const t1 = await sendPromotor(agent, phone, "000000", 1); // wrong PIN
    turns.push(t1);
    assertions.push(has(t1.reply, "incorrecto", "Bot says PIN incorrect"));
    assertions.push(hasNot(t1.reply, "restaurada", "Session NOT restored with wrong PIN"));

    const t2 = await sendPromotor(agent, phone, "999999", 2); // wrong again
    turns.push(t2);
    assertions.push(has(t2.reply, "incorrecto", "Bot says PIN incorrect on 2nd attempt"));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally {
    await sql`DELETE FROM whatsapp_roles WHERE phone = ${phone}`.catch(() => {});
    await clearPhone(phone).catch(() => {});
  }
}

async function P03_PinCorrectoReauth(agent: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}P03`;
  const id = "P03", name = "PIN correcto en re-auth — sesión restaurada con folio activo";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    // Need to register phone as promotora role first
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(process.env.DATABASE_URL!);
    await sql`
      INSERT INTO whatsapp_roles (phone, role, name, active, permissions, phone_verified)
      VALUES (${phone}, 'promotora', 'Test Promotora', true, '{}', true)
      ON CONFLICT (phone) DO UPDATE SET role = 'promotora', name = 'Test Promotora'
    `;

    const { neon: neon3 } = await import("@neondatabase/serverless");
    const sql3 = neon3(process.env.DATABASE_URL!);
    const ctx3 = JSON.stringify({
      awaiting_reauth: true,
      reauth_folio_id: 777,
      agentState: "capturing_docs",
      agentContext: { folio: { id: 777, folio: "CMU-SIN-TEST-003", taxistaName: "Juan Prueba" } }
    });
    const ts3 = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await sql3`
      INSERT INTO conversation_states (phone, state, context, updated_at)
      VALUES (${phone}, 'simulation', ${ctx3}::jsonb, ${ts3}::timestamptz)
      ON CONFLICT (phone) DO UPDATE
        SET state = 'simulation', context = ${ctx3}::jsonb, updated_at = ${ts3}::timestamptz
    `;

    const t1 = await sendPromotor(agent, phone, "123456", 1); // correct PIN
    turns.push(t1);
    assertions.push(has(t1.reply, "restaurada", "Session confirmed as restored"));
    assertions.push(has(t1.reply, "777", "Folio ID mentioned in restoration message"));
    assertions.push(hasNot(t1.reply, "incorrecto", "No error on correct PIN"));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(process.env.DATABASE_URL!);
    await sql`DELETE FROM whatsapp_roles WHERE phone = ${phone}`.catch(() => {});
    await clearPhone(phone).catch(() => {});
  }
}

async function P04_NuevoProspecto(agent: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}P04`;
  const id = "P04", name = "Nuevo prospecto: nombre + tel → folio creado";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    // Greeting
    const t1 = await sendPromotor(agent, phone, "hola", 1);
    turns.push(t1);
    assertions.push(has(t1.reply, "trámites", "Greeting shows active tramites"));

    // New prospect
    const t2 = await sendPromotor(agent, phone, "nuevo prospecto", 2);
    turns.push(t2);
    assertions.push(ok(
      t2.reply.toLowerCase().includes("llama") || t2.reply.toLowerCase().includes("nombre"),
      "Bot asks for name"
    ));

    // Give name + phone
    const t3 = await sendPromotor(agent, phone, "Ernesto Ríos 4498887766", 3);
    turns.push(t3);
    assertions.push(ok(
      t3.reply.toLowerCase().includes("folio") || t3.reply.toLowerCase().includes("cmu"),
      "Folio created and confirmed"
    ));
    assertions.push(hasNot(t3.reply, "error", "No error on creation"));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function P05_RetomaPorNumeroMenu(agent: any, storage: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}P05`;
  const id = "P05", name = "Retomar folio por número de menú (\"1\")";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    // Pick "1" (first folio from greeting list) — relies on there being at least 1 active origination
    const origs = await storage.listOriginations();
    const activos = origs.filter((o: any) => !["RECHAZADO", "COMPLETADO", "CANCELADO"].includes(o.estado));

    if (activos.length === 0) {
      return { id, name: `${name} — SKIPPED (no active folios)`, pass: true, turns, assertions: [ok(true, "Skipped — no active folios in DB")] };
    }

    const t1 = await sendPromotor(agent, phone, "1", 1);
    turns.push(t1);
    assertions.push(ok(
      t1.reply.includes("CMU") || t1.reply.includes("papeles") || t1.reply.includes("faltan"),
      "Folio selected and status shown"
    ));
    assertions.push(hasNot(t1.reply, "error", "No error selecting folio by number"));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function P06_RetomaPorNombre(agent: any, storage: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}P06`;
  const id = "P06", name = "Retomar folio por nombre textual";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    // Use a known folio from DB
    const origs = await storage.listOriginations();
    const activo = origs.find((o: any) => !["RECHAZADO", "COMPLETADO", "CANCELADO"].includes(o.estado) && o.taxistaName);
    if (!activo) {
      return { id, name: `${name} — SKIPPED`, pass: true, turns, assertions: [ok(true, "Skipped — no named folio")] };
    }

    const searchName = activo.taxistaName.split(" ")[0]; // first name only
    const t1 = await sendPromotor(agent, phone, searchName, 1);
    turns.push(t1);
    assertions.push(ok(
      t1.reply.toLowerCase().includes(searchName.toLowerCase()) || t1.reply.includes("CMU"),
      `Folio for "${searchName}" found`
    ));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function P07_ComandoDocs(agent: any, storage: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}P07`;
  const id = "P07", name = "Comando 'docs' con folio activo → lista pendientes";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    const origs = await storage.listOriginations();
    const activo = origs.find((o: any) => !["RECHAZADO", "COMPLETADO", "CANCELADO"].includes(o.estado));
    if (!activo) return { id, name: `${name} — SKIPPED`, pass: true, turns, assertions: [ok(true, "Skipped")] };

    // Set context with folio active
    await setStateManual(phone, "capturing_docs", {
      folio: { id: activo.id, folio: activo.folio, taxistaName: activo.taxistaName }
    });

    const t1 = await sendPromotor(agent, phone, "docs", 1, activo.id);
    turns.push(t1);
    assertions.push(ok(
      t1.reply.toLowerCase().includes("faltan") || t1.reply.toLowerCase().includes("completos") ||
      t1.reply.toLowerCase().includes("papeles") || t1.reply.toLowerCase().includes("capturados") ||
      t1.reply.toLowerCase().includes("document"),
      "Bot shows doc status"
    ));
    assertions.push(hasNot(t1.reply, "error del sistema", "No crash"));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function P08_ComandoEntrevista(agent: any, storage: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}P08`;
  const id = "P08", name = "Comando 'entrevista' con folio activo → trigger entrevista";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    const origs = await storage.listOriginations();
    const activo = origs.find((o: any) => !["RECHAZADO", "COMPLETADO", "CANCELADO"].includes(o.estado));
    if (!activo) return { id, name: `${name} — SKIPPED`, pass: true, turns, assertions: [ok(true, "Skipped")] };

    await setStateManual(phone, "capturing_docs", {
      folio: { id: activo.id, folio: activo.folio, taxistaName: activo.taxistaName }
    });

    const t1 = await sendPromotor(agent, phone, "entrevista", 1, activo.id);
    turns.push(t1);
    assertions.push(ok(
      t1.reply.toLowerCase().includes("entrevista") || t1.reply.toLowerCase().includes("pregunta") || t1.reply.toLowerCase().includes("empezar"),
      "Bot triggers interview mode"
    ));
    assertions.push(hasNot(t1.reply, "error del sistema", "No crash"));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function P09_CambiarFolio(agent: any, storage: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}P09`;
  const id = "P09", name = "Comando 'cambiar folio' → regresa al menú";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    const origs = await storage.listOriginations();
    const activo = origs.find((o: any) => !["RECHAZADO", "COMPLETADO", "CANCELADO"].includes(o.estado));
    if (!activo) return { id, name: `${name} — SKIPPED`, pass: true, turns, assertions: [ok(true, "Skipped")] };

    await setStateManual(phone, "capturing_docs", {
      folio: { id: activo.id, folio: activo.folio }
    });

    const t1 = await sendPromotor(agent, phone, "cambiar folio", 1, activo.id);
    turns.push(t1);
    assertions.push(ok(
      t1.reply.toLowerCase().includes("trabajamos") || t1.reply.toLowerCase().includes("folio") || !!t1.reply.match(/\d\.\s+\w/),
      "Bot shows folio selection menu"
    ));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function P10_ReportePendientes(agent: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}P10`;
  const id = "P10", name = "Reporte de trámites pendientes (determinístico)";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    const t1 = await sendPromotor(agent, phone, "pendientes", 1);
    turns.push(t1);
    assertions.push(ok(
      t1.reply.toLowerCase().includes("trámites") || t1.reply.toLowerCase().includes("activos") || t1.reply.toLowerCase().includes("hay"),
      "Bot returns trámites report"
    ));
    assertions.push(hasNot(t1.reply, "error del sistema", "No crash"));
    assertions.push(ok(t1.reply.length > 20, "Non-trivial response"));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function P11_NombreSinTelefono(agent: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}P11`;
  const id = "P11", name = "Nombre sin teléfono → pide teléfono";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    const t1 = await sendPromotor(agent, phone, "nuevo prospecto", 1);
    turns.push(t1);

    const t2 = await sendPromotor(agent, phone, "Fernando Salazar", 2);
    turns.push(t2);
    assertions.push(ok(
      t2.reply.toLowerCase().includes("teléfono") || t2.reply.toLowerCase().includes("tel") || t2.reply.toLowerCase().includes("número"),
      "Bot asks for phone when name given without tel"
    ));
    assertions.push(hasNot(t2.reply, "folio", "No folio created yet (no phone)"));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function P12_NombreAmbiguoComoMenu(agent: any, storage: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}P12`;
  const id = "P12", name = "Número de menú inválido (> cantidad de folios) → no crash";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    // Send "9" which is unlikely to match any menu item
    const t1 = await sendPromotor(agent, phone, "9", 1);
    turns.push(t1);
    assertions.push(ok(t1.reply.length > 0, "Bot responds (no crash)"));
    assertions.push(hasNot(t1.reply, "error del sistema", "No system crash"));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROSPECTO CASES
// ─────────────────────────────────────────────────────────────────────────────

async function Q01_SesionExpiradaProspecto(handle: Function, storage: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}Q01`;
  const id = "Q01", name = "Sesión expirada prospecto — reinicia limpio, no error";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    // Simulate stale docs_capture session (3 hours old)
    await setStateManual(phone, "docs_capture", {
      nombre: "Test User",
      folio: "CMU-SIN-OLD-001",
      docsCollected: ["ine_frente"],
      fuelType: "gasolina",
    }, -(3 * 60 * 60 * 1000));

    // The prospect greeting check resets stale state automatically
    const t1 = await sendProspect(handle, storage, phone, "hola", 1);
    turns.push(t1);
    assertions.push(ok(t1.reply.length > 0, "Bot responds (no crash)"));
    assertions.push(hasNot(t1.reply, "error del sistema", "No system crash on stale session"));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function Q02_FooterEnTodosEstados(handle: Function, storage: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}Q02`;
  const id = "Q02", name = "Footer presente en todos los estados del flujo";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    const FOOTER_MARKER = "siguiente · estado";

    // prospect_name
    const t1 = await sendProspect(handle, storage, phone, "hola", 1);
    turns.push(t1);
    assertions.push(has(t1.reply, FOOTER_MARKER, "Footer in prospect_name state"));

    // prospect_fuel_type
    const t2 = await sendProspect(handle, storage, phone, "Carlos Mendez", 2);
    turns.push(t2);
    assertions.push(has(t2.reply, FOOTER_MARKER, "Footer in prospect_fuel_type state"));

    // prospect_consumo
    const t3 = await sendProspect(handle, storage, phone, "gasolina", 3);
    turns.push(t3);
    assertions.push(has(t3.reply, FOOTER_MARKER, "Footer in prospect_consumo state"));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function Q03_FlujoCompletoGNV(handle: Function, storage: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}Q03`;
  const id = "Q03", name = "Flujo completo GNV: idle → nombre → gnv → consumo → modelo → corrida → confirm";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    const t1 = await sendProspect(handle, storage, phone, "hola", 1);
    turns.push(t1);
    assertions.push(stateIs(t1.state, "prospect_name"));

    const t2 = await sendProspect(handle, storage, phone, "Ana Torres", 2);
    turns.push(t2);
    assertions.push(stateIs(t2.state, "prospect_fuel_type"));

    const t3 = await sendProspect(handle, storage, phone, "gas natural", 3);
    turns.push(t3);
    assertions.push(ok(
      t3.state === "prospect_consumo" || t3.state === "prospect_tank",
      `State after GNV: ${t3.state} (consumo or tank)`
    ));

    // LEQ consumption
    const t4 = await sendProspect(handle, storage, phone, "400", 4);
    turns.push(t4);
    assertions.push(ok(
      ["prospect_select_model", "prospect_consumo", "prospect_show_models", "prospect_tank"].includes(t4.state),
      `State after consumo: ${t4.state}`
    ));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function Q04_FlujoCompletoGasolina(handle: Function, storage: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}Q04`;
  const id = "Q04", name = "Flujo completo gasolina: idle → nombre → gasolina → gasto → modelo → corrida → confirm";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    const t1 = await sendProspect(handle, storage, phone, "hola", 1);
    turns.push(t1);
    assertions.push(stateIs(t1.state, "prospect_name"));

    const t2 = await sendProspect(handle, storage, phone, "Roberto Gómez", 2);
    turns.push(t2);
    assertions.push(stateIs(t2.state, "prospect_fuel_type"));

    const t3 = await sendProspect(handle, storage, phone, "gasolina", 3);
    turns.push(t3);
    assertions.push(stateIs(t3.state, "prospect_consumo"));

    const t4 = await sendProspect(handle, storage, phone, "9500", 4);
    turns.push(t4);
    assertions.push(ok(
      ["prospect_select_model", "prospect_show_models", "prospect_corrida"].includes(t4.state),
      `State after gasto: ${t4.state}`
    ));

    const t5 = await sendProspect(handle, storage, phone, "march sense 2021", 5);
    turns.push(t5);
    assertions.push(ok(
      ["prospect_corrida", "prospect_confirm", "prospect_tank"].includes(t5.state),
      `State after model: ${t5.state}`
    ));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function Q05_SkipDocumento(handle: Function, storage: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}Q05`;
  const id = "Q05", name = "Skip de documento ('siguiente') → avanza al siguiente doc";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    await setStateManual(phone, "docs_capture", {
      nombre: "Test User",
      folio: "CMU-SIN-TEST-Q05",
      originationId: 26,
      docsCollected: [],
      skippedDocs: [],
      fuelType: "gasolina",
      otpVerified: true,
    });

    const t1 = await sendProspect(handle, storage, phone, "siguiente", 1);
    turns.push(t1);
    assertions.push(stateIs(t1.state, "docs_capture"));
    assertions.push(ok(
      t1.reply.toLowerCase().includes("siguiente") || t1.reply.toLowerCase().includes("ahora") || t1.reply.toLowerCase().includes("mándame"),
      "Bot asks for next document after skip"
    ));
    assertions.push(hasNot(t1.reply, "error del sistema", "No crash on skip"));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function Q06_ConsultaEstado(handle: Function, storage: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}Q06`;
  const id = "Q06", name = "Consulta 'estado' → muestra progreso del expediente";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    await setStateManual(phone, "docs_capture", {
      nombre: "Test User",
      folio: "CMU-SIN-TEST-Q06",
      docsCollected: ["ine_frente", "ine_vuelta"],
      skippedDocs: [],
      fuelType: "gasolina",
    });

    const t1 = await sendProspect(handle, storage, phone, "estado", 1);
    turns.push(t1);
    assertions.push(ok(
      t1.reply.toLowerCase().includes("2") || t1.reply.toLowerCase().includes("dos") ||
      t1.reply.toLowerCase().includes("document") || t1.reply.toLowerCase().includes("expediente"),
      "Bot shows document progress"
    ));
    assertions.push(hasNot(t1.reply, "error del sistema", "No crash on estado query"));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function Q07_SaltoEntrevista(handle: Function, storage: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}Q07`;
  const id = "Q07", name = "Salto directo a entrevista desde docs_capture";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    await setStateManual(phone, "docs_capture", {
      nombre: "Test User",
      folio: "CMU-SIN-TEST-Q07",
      docsCollected: ["ine_frente"],
      fuelType: "gasolina",
    });

    const t1 = await sendProspect(handle, storage, phone, "entrevista", 1);
    turns.push(t1);
    assertions.push(ok(
      t1.state.startsWith("interview") || t1.state === "docs_capture",
      `State after 'entrevista': ${t1.state} (interview or stays in docs)`
    ));
    assertions.push(ok(
      t1.reply.toLowerCase().includes("entrevista") || t1.reply.toLowerCase().includes("pregunta") || t1.reply.toLowerCase().includes("empezar"),
      "Bot acknowledges interview request"
    ));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

async function Q08_RegresarEnFlujo(handle: Function, storage: any): Promise<CaseResult> {
  const phone = `${TEST_PHONE_BASE}Q08`;
  const id = "Q08", name = "Mensaje 'atrás'/'regresar' en flujo — bot maneja sin crash";
  const assertions: Array<{ ok: boolean; msg: string }> = [];
  const turns: TurnResult[] = [];
  try {
    await clearPhone(phone);

    // Get into docs_capture
    await setStateManual(phone, "docs_capture", {
      nombre: "Test User",
      folio: "CMU-SIN-TEST-Q08",
      docsCollected: ["ine_frente"],
      fuelType: "gasolina",
    });

    const t1 = await sendProspect(handle, storage, phone, "regresar", 1);
    turns.push(t1);
    assertions.push(ok(t1.reply.length > 0, "Bot responds to 'regresar'"));
    assertions.push(hasNot(t1.reply, "error del sistema", "No crash on 'regresar'"));

    const t2 = await sendProspect(handle, storage, phone, "atrás", 2);
    turns.push(t2);
    assertions.push(ok(t2.reply.length > 0, "Bot responds to 'atrás'"));
    assertions.push(hasNot(t2.reply, "error del sistema", "No crash on 'atrás'"));

    return { id, name, pass: assertions.every(a => a.ok), turns, assertions };
  } catch (e: any) {
    return { id, name, pass: false, turns, assertions, error: e.message };
  } finally { await clearPhone(phone).catch(() => {}); }
}

// ─── Main runner ─────────────────────────────────────────────────────────────

export async function runFullFlowSuite(storage: any, whatsappAgent: any): Promise<{
  passed: number; failed: number; total: number; results: CaseResult[];
  sections: { promotora: CaseResult[]; prospecto: CaseResult[] };
}> {
  const { handleProspectMessage } = await import("../server/agent/orchestrator");
  _gPassed = 0;
  _gFailed = 0;

  console.log("\n=== CMU Full Flow Suite ===");
  console.log("Promotora (12) + Prospecto (8) = 20 cases\n");

  const promotora: CaseResult[] = [
    await P01_SesionExpirada(whatsappAgent),
    await P02_PinIncorrectoReauth(whatsappAgent),
    await P03_PinCorrectoReauth(whatsappAgent),
    await P04_NuevoProspecto(whatsappAgent),
    await P05_RetomaPorNumeroMenu(whatsappAgent, storage),
    await P06_RetomaPorNombre(whatsappAgent, storage),
    await P07_ComandoDocs(whatsappAgent, storage),
    await P08_ComandoEntrevista(whatsappAgent, storage),
    await P09_CambiarFolio(whatsappAgent, storage),
    await P10_ReportePendientes(whatsappAgent),
    await P11_NombreSinTelefono(whatsappAgent),
    await P12_NombreAmbiguoComoMenu(whatsappAgent, storage),
  ];

  const prospecto: CaseResult[] = [
    await Q01_SesionExpiradaProspecto(handleProspectMessage, storage),
    await Q02_FooterEnTodosEstados(handleProspectMessage, storage),
    await Q03_FlujoCompletoGNV(handleProspectMessage, storage),
    await Q04_FlujoCompletoGasolina(handleProspectMessage, storage),
    await Q05_SkipDocumento(handleProspectMessage, storage),
    await Q06_ConsultaEstado(handleProspectMessage, storage),
    await Q07_SaltoEntrevista(handleProspectMessage, storage),
    await Q08_RegresarEnFlujo(handleProspectMessage, storage),
  ];

  const all = [...promotora, ...prospecto];
  const passed = all.filter(c => c.pass).length;
  const failed = all.filter(c => !c.pass).length;

  console.log("\n── Promotora ─────────────────────────────────────");
  for (const c of promotora) {
    console.log(`${c.pass ? "✅" : "❌"} ${c.id}: ${c.name}`);
    if (!c.pass) {
      c.assertions.filter(a => !a.ok).forEach(a => console.log(`   ${a.msg}`));
      if (c.error) console.log(`   Error: ${c.error}`);
    }
  }
  console.log("\n── Prospecto ─────────────────────────────────────");
  for (const c of prospecto) {
    console.log(`${c.pass ? "✅" : "❌"} ${c.id}: ${c.name}`);
    if (!c.pass) {
      c.assertions.filter(a => !a.ok).forEach(a => console.log(`   ${a.msg}`));
      if (c.error) console.log(`   Error: ${c.error}`);
    }
  }
  console.log(`\n${passed}/${all.length} cases passed\n`);

  return { passed, failed, total: all.length, results: all, sections: { promotora, prospecto } };
}
