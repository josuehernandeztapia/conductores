/**
 * Conversation State Machine — WhatsApp Agent v9
 * 
 * Tracks where each user is in the conversation flow.
 * Persisted to Neon DB so state survives server restarts.
 * 
 * States:
 *   idle          — No active context. Greeting or new topic.
 *   evaluating    — Evaluating a vehicle purchase (director flow)
 *   browsing_prices — Looking at market prices
 *   asking_info   — Asking about the program (FAQ, requirements, docs)
 *   onboarding    — Starting an origination for a taxista
 *   capturing_docs — In the middle of document capture for a folio
 *   simulation    — Running a payment simulation for a prospect
 */

import { neon } from "@neondatabase/serverless";

export type ConversationState =
  // v9 known-role states
  | "idle"
  | "evaluating"
  | "browsing_prices"
  | "asking_info"
  | "onboarding"
  | "capturing_docs"
  | "simulation"
  // v4 prospect states (written by orchestrator to shared session)
  | "prospect_name"
  | "prospect_fuel_type"
  | "prospect_consumo"
  | "prospect_select_model"
  | "prospect_tank"
  | "prospect_corrida"
  | "prospect_confirm"
  | "prospect_show_models"
  | "prospect_post_corrida"
  | "prospect_gnv_consumo"
  | "prospect_gasolina_gasto"
  | "prospect_tank_question"
  | "prospect_awaiting_name"
  | "prospect_cold"
  | "prospect_docs_capture"
  | "awaiting_variant"
  | "awaiting_inventory_pin"
  | "docs_capture"
  | "docs_pending"
  | "interview_ready"
  | "interview_q0"
  | "interview_q1" | "interview_q2" | "interview_q3" | "interview_q4"
  | "interview_q5" | "interview_q6" | "interview_q7" | "interview_q8"
  | "interview_complete"
  | "completed";

export type ConversationContext = {
  // Vehicle being discussed (catalog or not)
  vehicle?: {
    brand: string;
    model: string;
    variant?: string | null;
    year: number;
    cmu?: number; // only if in catalog
    inCatalog: boolean;
  };
  // Evaluation in progress
  eval?: {
    cost?: number;
    repair?: number;
    conTanque?: boolean;
    marketAvg?: number;
  };
  // Origination in progress
  folio?: {
    id: number;
    folio: string;
    estado: string;
    step: number;
    docsCapturados: string[];
    docsPendientes: string[];
    taxistaName?: string;
  };
  // Last topic discussed (for context continuity)
  lastTopic?: string;
  // Promo kit active
  promoKitActiva?: boolean;
  // v4 prospect agent context (stored as nested object)
  agentState?: string;
  agentContext?: Record<string, any>;
  // Pending corrida formatted text
  pendingCorrida?: string | null;
  // Canal and prospect data
  canal?: string;
  fuelType?: string;
  leqMes?: number;
  modelo?: string | { marca: string; modelo: string; anio: number };
  pv?: number;
  docsComplete?: boolean;
  pendingEval?: Record<string, any>;
  pendingEdit?: Record<string, any>;
  interview?: Record<string, any>;
  recaudo?: Record<string, any> | number;
  kitNuevo?: boolean;
  nombre?: string;
  gastoGasolina?: number;
};

export type ConversationSession = {
  phone: string;
  state: ConversationState;
  context: ConversationContext;
  lastModel: any | null;
  folioId: number | null;
  messages: Array<{ role: "user" | "assistant"; content: string; ts: number }>;
  lastActivity: number;
};

// In-memory cache (backed by DB)
const sessions = new Map<string, ConversationSession>();
const SESSION_TTL = 0; // Always read from DB (multi-machine Fly.io)
const MAX_MESSAGES = 20;

function getDb() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;
  return neon(dbUrl);
}

/** Get or create a session for a phone number */
export async function getSession(phone: string): Promise<ConversationSession> {
  // Check memory cache
  const cached = sessions.get(phone);
  if (cached && Date.now() - cached.lastActivity < SESSION_TTL) {
    cached.lastActivity = Date.now();
    return cached;
  }

  // Check DB
  const sql = getDb();
  if (sql) {
    try {
      const rows = await sql`SELECT state, context, last_model, folio_id, updated_at FROM conversation_states WHERE phone = ${phone}` as any[];
      if (rows.length > 0) {
        const r = rows[0];
        // Use DB updated_at as lastActivity for accurate inactivity tracking
        const dbUpdatedAt = r.updated_at ? new Date(r.updated_at).getTime() : Date.now();
        const session: ConversationSession = {
          phone,
          state: r.state as ConversationState,
          context: (typeof r.context === "string" ? JSON.parse(r.context) : r.context) || {},
          lastModel: r.last_model ? (typeof r.last_model === "string" ? JSON.parse(r.last_model) : r.last_model) : null,
          folioId: r.folio_id,
          messages: cached?.messages || [], // preserve in-memory messages if any
          lastActivity: dbUpdatedAt,
        };
        sessions.set(phone, session);
        return session;
      }
    } catch (e: any) {
      console.error("[ConvState] DB read error:", e.message);
    }
  }

  // Create new session
  const session: ConversationSession = {
    phone,
    state: "idle",
    context: {},
    lastModel: null,
    folioId: null,
    messages: [],
    lastActivity: Date.now(),
  };
  sessions.set(phone, session);
  return session;
}

/** Update session state and persist to DB */
export async function updateSession(
  phone: string,
  updates: Partial<Pick<ConversationSession, "state" | "context" | "lastModel" | "folioId">>
): Promise<void> {
  const session = await getSession(phone);
  if (updates.state !== undefined) session.state = updates.state;
  if (updates.context !== undefined) session.context = { ...session.context, ...updates.context };
  if (updates.lastModel !== undefined) session.lastModel = updates.lastModel;
  if (updates.folioId !== undefined) session.folioId = updates.folioId;
  session.lastActivity = Date.now();
  sessions.set(phone, session);

  // Persist to DB
  const sql = getDb();
  if (sql) {
    try {
      const ctx = JSON.stringify(session.context || {});
      const lm = session.lastModel ? JSON.stringify(session.lastModel) : null;
      const fid = session.folioId || null;
      await sql`
        INSERT INTO conversation_states (phone, state, context, last_model, folio_id, updated_at)
        VALUES (${phone}, ${session.state}, ${ctx}, ${lm}, ${fid}, NOW())
        ON CONFLICT (phone)
        DO UPDATE SET state = ${session.state}, context = ${ctx}, 
                      last_model = ${lm}, folio_id = ${fid}, updated_at = NOW()
      `;
      console.log(`[ConvState] DB write OK: ${phone} → ${session.state}`);
    } catch (e: any) {
      console.error(`[ConvState] DB write FAILED for ${phone}:`, e.message);
    }
  } else {
    console.error(`[ConvState] No DATABASE_URL — state not persisted for ${phone}`);
  }
}

/** Add a message to the session history */
export function addMessage(phone: string, role: "user" | "assistant", content: string): void {
  const session = sessions.get(phone);
  if (!session) return;
  session.messages.push({ role, content, ts: Date.now() });
  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }
  session.lastActivity = Date.now();
}

/** Get message history for LLM context */
export function getHistory(phone: string, limit = 10): Array<{ role: "user" | "assistant"; content: string }> {
  const session = sessions.get(phone);
  if (!session) return [];
  return session.messages.slice(-limit).map(m => ({ role: m.role, content: m.content }));
}

/** Detect what the user is trying to do from their message */
export function detectIntent(text: string, currentState: ConversationState, role: string): {
  intent: "evaluate" | "prices" | "info" | "onboard" | "docs" | "simulate" | "dashboard" | "inventory" | "folios" | "greeting" | "continue" | "unknown";
  confidence: number;
} {
  const lower = text.toLowerCase().trim();

  // Greetings
  if (/^(hola|buenos?\s|buenas|hey|qué tal|que tal|oye)/.test(lower) && lower.length < 30) {
    return { intent: "greeting", confidence: 0.9 };
  }

  // Dashboard / inventory / folios (director commands)
  if (/^(n[uú]meros|numeros|dashboard|inventario|inv|folios)$/i.test(lower)) {
    const map: Record<string, any> = { "números": "dashboard", "numeros": "dashboard", "dashboard": "dashboard", "inventario": "inventory", "inv": "inventory", "folios": "folios" };
    return { intent: map[lower] || "dashboard", confidence: 1.0 };
  }

  // Evaluation signals (price + repair, "evalua", model + Xk)
  if (/\d{2,3}\s*k\b/.test(lower) || /rep(?:araci[oó]n)?\s*\d/i.test(lower) || /^\s*eval[uú]a/i.test(lower)) {
    return { intent: "evaluate", confidence: 0.9 };
  }

  // Price/market queries
  if (/precio|mercado|market|cu[aá]nto\s*(cuesta|vale)|precios/i.test(lower)) {
    return { intent: "prices", confidence: 0.9 };
  }

  // Simulation queries (cuánto pago, mensualidad, corrida)
  if (/cu[aá]nto\s*pag|mensualidad|corrida|simul/i.test(lower)) {
    return { intent: "simulate", confidence: 0.85 };
  }

  // Onboarding signals
  if (/folio|iniciar|aplicaci[oó]n|proceso|registr|quiero\s*(empezar|registrar|iniciar)|tengo.*taxista/i.test(lower)) {
    return { intent: "onboard", confidence: 0.85 };
  }

  // Document-related
  if (/documento|ine|csf|comprobante|concesi[oó]n|factura|selfie|estado\s*de\s*cuenta|historial|carta\s*membres/i.test(lower)) {
    return { intent: "docs", confidence: 0.8 };
  }

  // Info/FAQ queries
  if (/requisito|qu[eé]\s*(es|necesit|pasa|incluye)|c[oó]mo\s*(funciona|es|inicio)|programa|fondo\s*de\s*garant|obligaci|t[eé]rminos|condicion|mora|rescisi|anticipo|kit\s*gnv|amortizaci/i.test(lower)) {
    return { intent: "info", confidence: 0.85 };
  }

  // If currently in a state, assume continuation
  if (currentState !== "idle") {
    return { intent: "continue", confidence: 0.6 };
  }

  return { intent: "unknown", confidence: 0.3 };
}

/** Build a state summary string for the LLM system prompt */
export function buildStateContext(session: ConversationSession): string {
  const parts: string[] = [];
  parts.push(`ESTADO CONVERSACIÓN: ${session.state}`);

  if (session.context.vehicle) {
    const v = session.context.vehicle;
    parts.push(`VEHÍCULO EN DISCUSIÓN: ${v.brand} ${v.model} ${v.variant || ""} ${v.year}${v.cmu ? ` (CMU $${v.cmu.toLocaleString()})` : ""} — ${v.inCatalog ? "EN CATÁLOGO CMU" : "NO en catálogo CMU"}`);
  }

  if (session.context.eval) {
    const e = session.context.eval;
    const evalParts: string[] = [];
    if (e.cost) evalParts.push(`costo: $${e.cost.toLocaleString()}`);
    if (e.repair) evalParts.push(`rep: $${e.repair.toLocaleString()}`);
    if (e.marketAvg) evalParts.push(`mercado prom: $${e.marketAvg.toLocaleString()}`);
    if (evalParts.length > 0) parts.push(`EVALUACIÓN EN CURSO: ${evalParts.join(" | ")}`);
  }

  if (session.context.folio) {
    const f = session.context.folio;
    parts.push(`FOLIO ACTIVO: ${f.folio} | Estado: ${f.estado} | Paso: ${f.step}/7 | Docs: ${f.docsCapturados.length}/${f.docsCapturados.length + f.docsPendientes.length}${f.taxistaName ? ` | Taxista: ${f.taxistaName}` : ""}`);
    if (f.docsPendientes.length > 0) parts.push(`DOCUMENTOS PENDIENTES: ${f.docsPendientes.join(", ")}`);
  }

  if (session.lastModel && !session.context.vehicle) {
    const m = session.lastModel;
    parts.push(`ÚLTIMO MODELO DISCUTIDO: ${m.brand} ${m.model} ${m.variant || ""} ${m.year}`);
  }

  if (session.context.lastTopic) {
    parts.push(`ÚLTIMO TEMA: ${session.context.lastTopic}`);
  }

  return parts.join("\n");
}
