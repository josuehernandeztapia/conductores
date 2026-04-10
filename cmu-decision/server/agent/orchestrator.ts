/**
 * CMU WhatsApp Agent v4 — Orchestrator (State Machine)
 *
 * The core module. A deterministic state machine that:
 * - Controls ALL conversation flow
 * - NEVER generates responses from LLM (always uses templates)
 * - Uses NLU only to understand intent
 * - Uses Vision only to classify documents
 * - Uses RAG only to answer off-flow questions
 *
 * NEW FLOW ORDER (v4):
 * 1. idle → greeting + ask name
 * 2. prospect_name → receive name → explain program + ask fuel type
 * 3. prospect_fuel_type → GNV or gasolina
 * 4. prospect_consumo → LEQ/month → show 5 models
 * 5. prospect_select_model → pick model
 * 6. prospect_tank → reuse tank or new? (GNV only)
 * 7. prospect_corrida → show corrida + explain process + "¿le entramos?"
 * 8. prospect_confirm → yes → create folio → ask for INE
 * 9. docs_capture → docs one by one (skip, status, interview)
 * 10. interview_ready → "empezar"
 * 11. interview_q1..q8 → voice notes / text
 * 12. interview_complete → check pending docs
 * 13. docs_pending → same as docs_capture but after interview
 * 14. all_complete → "En revisión."
 */

import { neon } from "@neondatabase/serverless";

// ── Agent modules ──
import type {
  ProspectState,
  AgentContext,
  NLUResult,
  Intent,
} from "./types";
import { extractIntent } from "./nlu";
import {
  greeting,
  program_context,
  ask_consumo_gnv,
  ask_consumo_gasolina,
  consumo_out_of_range,
  gasto_out_of_range,
  show_models,
  no_models_available,
  ask_tank,
  show_corrida,
  folio_created,
  doc_received,
  doc_all_complete,
  doc_invalid,
  doc_skipped,
  doc_status,
  interview_intro,
  interview_question,
  interview_understood,
  interview_complete,
  fallback_no_understand,
  fallback_state_error,
  cold_goodbye,
  already_complete,
} from "./templates";
import type { ModelSummary } from "./templates";
import { classifyAndValidateDoc, DOC_ORDER, DOC_LABELS, getNextExpectedDoc, getPendingDocLabels } from "./vision";
import { chatCompletion, whisperTranscribe } from "./openai-helper";
import { answerQuestion } from "./rag";
import { notifyTeam, notifyDirector } from "./notifications";

// ── Existing modules ──
import {
  generarResumen5Modelos,
  generarCorridaEstimada,
  matchModelFromText,
  getPvForModel,
  buildAmortRows,
  MODELOS_PROSPECTO,
} from "../corrida-estimada";
import {
  getInterviewWelcome,
  getCurrentQuestion,
  processAnswer as processInterviewAnswer,
  type InterviewState,
} from "../entrevista-whatsapp";
import {
  upsertProspect,
  detectCanal,
  updateProspectStatus,
  updateProspectDocs,
} from "../pipeline-ventas";
import { getSession, updateSession } from "../conversation-state";
import { createFolioFromWhatsApp } from "../folio-manager";
import { DIRECTOR, getPromotor } from "../team-config";

// ─── Constants ───────────────────────────────────────────────────────────────

const SOBREPRECIO_GNV = 11;    // $11/LEQ
const BASE_LEQ = 400;          // base 400 LEQ/mes
const KIT_NUEVO_COST = 9400;   // +$9,400 for new GNV kit
const TOTAL_DOCS = DOC_ORDER.length; // 14

// Gasolina to LEQ conversion:
// Simplified: pesosMes / 11
function pesosToLeq(pesosMes: number): number {
  return Math.round(pesosMes / 11);
}

// ─── Audio / Media Helpers ──────────────────────────────────────────────────

/**
 * Download media from Twilio URL using Basic auth.
 */
async function downloadTwilioMedia(mediaUrl: string): Promise<Buffer> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
  }

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const response = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  if (!response.ok) {
    throw new Error(`Twilio media download failed: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Transcribe audio using OpenAI Whisper.
 */
async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  return await whisperTranscribe(audioBuffer);
}

// ─── LLM Call Helper (for interview) ─────────────────────────────────────────

async function llmCall(messages: any[], maxTokens: number): Promise<string> {
  return await chatCompletion(messages, { max_tokens: maxTokens, temperature: 0 });
}

// ─── DB Helpers ──────────────────────────────────────────────────────────────

function getSQL() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("No DATABASE_URL");
  return neon(url);
}

// ─── Map doc key → originations column ─────────────────────────────────────
const DOC_KEY_TO_ORIGINATIONS_COL: Record<string, string> = {
  ine_frente:       "datos_ine",
  ine_reverso:      "datos_ine",          // merged into same field
  licencia:         "datos_ine",          // license stored alongside INE
  factura_vehiculo: "datos_factura",
  csf:              "datos_csf",
  comprobante_domicilio: "datos_comprobante",
  tarjeta_circulacion:   "datos_concesion",  // circulation card
  concesion:        "datos_concesion",
  estado_cuenta:    "datos_estado_cuenta",
  historial_gnv:    "datos_historial",
  tickets_gasolina: "datos_historial",
  membresia_gremial:"datos_membresia",
  curp:             "datos_csf",           // CURP alongside CSF
  rfc:              "datos_csf",           // RFC alongside CSF
};

// Flush OCR data to originations structured columns
async function flushOCRToOrigination(
  phone: string,
  docKey: string,
  extractedData: Record<string, any>,
): Promise<void> {
  const col = DOC_KEY_TO_ORIGINATIONS_COL[docKey];
  if (!col) return; // unmapped doc — skip
  try {
    const sql = getSQL();
    // Get folio_id for this phone
    const rows = await sql`SELECT folio_id FROM conversation_states WHERE phone = ${phone}` as any[];
    const folioId = rows[0]?.folio_id;
    if (!folioId) return;

    // Merge with existing column value (JSON merge, so two docs mapping to same column accumulate)
    const existing = await sql`SELECT ${sql(col)} as val FROM originations WHERE id = ${folioId}` as any[];
    let merged: Record<string, any> = {};
    try { merged = existing[0]?.val ? JSON.parse(existing[0].val) : {}; } catch {}
    const updated = { ...merged, ...extractedData, _doc_key: docKey, _captured_at: new Date().toISOString() };

    await sql`UPDATE originations SET ${sql(col)} = ${JSON.stringify(updated)}, updated_at = NOW() WHERE id = ${folioId}`;
    console.log(`[OCR→Neon] ${docKey} → originations.${col} (folio_id=${folioId})`);
  } catch (err: any) {
    console.error(`[OCR→Neon] flushOCRToOrigination failed for ${docKey}:`, err.message);
  }
}

// Flush interview data to originations.interview_data
async function flushInterviewToOrigination(
  phone: string,
  interviewAnswers: Record<string, any>,
  coherencia?: Record<string, any>,
): Promise<void> {
  try {
    const sql = getSQL();
    const rows = await sql`SELECT folio_id FROM conversation_states WHERE phone = ${phone}` as any[];
    const folioId = rows[0]?.folio_id;
    if (!folioId) return;

    const payload = JSON.stringify({ answers: interviewAnswers, coherencia: coherencia || {}, _saved_at: new Date().toISOString() });
    // interview_data column may not exist yet — add it if missing
    await sql`
      ALTER TABLE originations ADD COLUMN IF NOT EXISTS interview_data jsonb;
    `;
    await sql`UPDATE originations SET interview_data = ${payload}::jsonb, updated_at = NOW() WHERE id = ${folioId}`;
    console.log(`[Interview→Neon] saved interview data (folio_id=${folioId})`);
  } catch (err: any) {
    console.error(`[Interview→Neon] flushInterviewToOrigination failed:`, err.message);
  }
}

async function saveDocument(
  originationId: number,
  docKey: string,
  docLabel: string,
  extractedData: Record<string, any>,
  imageUrl: string,
  crossCheckFlags: string[],
): Promise<void> {
  try {
    const sql = getSQL();
    await sql`
      INSERT INTO documents (origination_id, tipo, image_data, ocr_result, ocr_confidence, status, created_at, source)
      VALUES (${originationId}, ${docKey}, ${imageUrl}, ${JSON.stringify(extractedData)}, ${JSON.stringify(crossCheckFlags)}, 'verified', NOW(), 'whatsapp_v3')
    `;
  } catch (error: any) {
    console.error(`[Orchestrator] saveDocument failed for ${docKey}:`, error.message);
  }
}

// ─── Build Model Summaries ───────────────────────────────────────────────────

async function buildModelSummaries(leq: number): Promise<{
  summaries: ModelSummary[];
  recaudo: number;
}> {
  const recaudo = leq * SOBREPRECIO_GNV;
  const summaries: ModelSummary[] = [];

  for (const m of MODELOS_PROSPECTO) {
    try {
      const pv = await getPvForModel(m.marca, m.modelo, m.anios[0]);
      const { rows, mesGnvCubre } = buildAmortRows(pv, leq);
      const m3 = rows[2];
      const name = `${m.marca} ${m.modelo} ${m.anios[0]}`;
      summaries.push({
        name,
        precio: pv,
        cuotaM3: m3.cuota,
        bolsillo: m3.diferencial,
        mesGnvLabel: mesGnvCubre ? `GNV cubre todo desde mes ${mesGnvCubre}` : "GNV cubre todo desde mes 34+",
      });
    } catch (error: any) {
      console.error(`[Orchestrator] buildModelSummaries failed for ${m.modelo}:`, error.message);
    }
  }

  return { summaries, recaudo };
}

// ─── Helper: get firstName from context ──────────────────────────────────────

function getFirstName(ctx: AgentContext): string {
  if (ctx.nombre) return ctx.nombre.split(" ")[0];
  if (ctx.profileName) return ctx.profileName.split(" ")[0];
  return "";
}

// ─── Helper: explicit intent override for known patterns ─────────────────────

/**
 * CRITICAL FIX: Pre-NLU explicit checks for patterns that NLU may misclassify.
 * - "1" / "2" in prospect_tank → reuse_tank / new_tank
 * - "falta" / "estado" / "pendiente" → ask_progress (NOT give_name)
 * - "siguiente" → skip_doc
 */
function preNluOverride(body: string, state: string): NLUResult | null {
  const trimmed = body.trim().toLowerCase();

  // ── CRITICAL FIX #1: "1" and "2" in prospect_tank ──
  if (state === "prospect_tank") {
    if (trimmed === "1" || trimmed === "1️⃣") {
      return { intent: "reuse_tank", entities: {}, confidence: 1.0 };
    }
    if (trimmed === "2" || trimmed === "2️⃣") {
      return { intent: "new_tank", entities: {}, confidence: 1.0 };
    }
  }

  // ── CRITICAL FIX #5: "qué me falta" / "estado" / "pendiente" → ask_progress ──
  if (/falta|estado|pendiente|proceso|cu[aá]ntos?\s+(faltan|llevo)|c[oó]mo\s+voy/.test(trimmed)) {
    // Only override when in doc-related or post-interview states
    if (
      state === "docs_capture" ||
      state === "docs_pending" ||
      state === "interview_complete" ||
      state === "prospect_confirm" ||
      state === "completed"
    ) {
      return { intent: "ask_progress", entities: {}, confidence: 1.0 };
    }
  }

  // ── "siguiente" in docs states → skip_doc ──
  if (/^(siguie?nte|siguiente|sigiente|siguente|skip|saltar|brincar)$/i.test(trimmed)) {
    if (state === "docs_capture" || state === "docs_pending" || state === "completed") {
      return { intent: "skip_doc", entities: {}, confidence: 1.0 };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Main entry point for the agent v4.
 * Processes a prospect's WhatsApp message and returns a response string.
 *
 * @param phone - Sender phone number (cleaned, e.g. "5214421234567")
 * @param body - Text body of the message (empty string if media-only)
 * @param mediaUrl - Twilio media URL (null if text-only)
 * @param mediaType - MIME type of media (null if text-only), e.g. "image/jpeg", "audio/ogg"
 * @param profileName - WhatsApp profile name
 * @param storage - IStorage interface for DB operations (folio creation)
 * @returns Response string (always from template, never from LLM)
 */
export async function handleProspectMessage(
  phone: string,
  body: string,
  mediaUrl: string | null,
  mediaType: string | null,
  profileName: string,
  storage: any,
): Promise<string> {
  // ── Load session ──
  const session = await getSession(phone);
  const currentState = (session.context as any)?.agentState as ProspectState || "idle";
  const ctx: AgentContext = (session.context as any)?.agentContext || {};
  ctx.profileName = ctx.profileName || profileName;

  console.log(`[Orchestrator] ${phone} | state=${currentState} | body="${body?.slice(0, 50)}" | media=${mediaType || "none"}`);

  let response: string;
  let newState: ProspectState = currentState;
  let contextUpdates: Partial<AgentContext> = {};

  try {
    // ── Handle audio messages ──
    if (mediaUrl && mediaType && mediaType.startsWith("audio/")) {
      const result = await handleAudioMessage(phone, mediaUrl, currentState, ctx, storage);
      response = result.response;
      newState = result.newState;
      contextUpdates = result.contextUpdates;
    }
    // ── Handle image messages ──
    else if (mediaUrl && mediaType && (mediaType.startsWith("image/") || mediaType === "application/pdf")) {
      const result = await handleImageMessage(phone, mediaUrl, mediaType, currentState, ctx, body, storage);
      response = result.response;
      newState = result.newState;
      contextUpdates = result.contextUpdates;
    }
    // ── Handle text messages ──
    else {
      const result = await handleTextMessage(phone, body, currentState, ctx, storage);
      response = result.response;
      newState = result.newState;
      contextUpdates = result.contextUpdates;
    }
  } catch (error: any) {
    console.error(`[Orchestrator] Unhandled error for ${phone}:`, error.message);
    response = fallback_state_error();
  }

  // ── Persist state ──
  const updatedContext: AgentContext = { ...ctx, ...contextUpdates };
  try {
    await updateSession(phone, {
      state: "simulation" as any,
      context: {
        ...session.context,
        agentState: newState,
        agentContext: updatedContext,
      } as any,
    });
  } catch (error: any) {
    console.error(`[Orchestrator] State persist failed for ${phone}:`, error.message);
  }

  // ── Append persistent footer so the prospect always knows their options ──
  const STATES_WITH_FOOTER: ProspectState[] = [
    "prospect_name", "prospect_fuel_type", "prospect_consumo", "prospect_select_model",
    "prospect_tank", "prospect_corrida", "prospect_confirm",
    "docs_capture", "docs_pending", "interview_ready",
    "interview_q1", "interview_q2", "interview_q3", "interview_q4",
    "interview_q5", "interview_q6", "interview_q7", "interview_q8",
  ];
  const FOOTER = `\n\n────────────────\n_siguiente · estado · entrevista · promotor_`;
  if (STATES_WITH_FOOTER.includes(newState) && !response.includes("siguiente · estado")) {
    response = response + FOOTER;
  }

  console.log(`[Orchestrator] ${phone} | ${currentState} → ${newState} | response="${response.slice(0, 60)}..."`);
  return response;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEXT MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleTextMessage(
  phone: string,
  body: string,
  state: ProspectState,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  // ── OTP code check (6 digits) ──
  const otpMatch = body.trim().match(/^(\d{6})$/);
  if (otpMatch && ctx.otpSent && !ctx.otpVerified) {
    try {
      const code = otpMatch[1];
      const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID || "VAb7b31cdc560d238ed2bd90da259b9a12";
      const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || "";
      const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
      const otpPhone = phone.startsWith("+") ? phone : `+${phone}`;
      const authHeader = "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
      const resp = await fetch(`https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SID}/VerificationCheck`, {
        method: "POST",
        headers: { "Authorization": authHeader, "Content-Type": "application/x-www-form-urlencoded" },
        body: `To=${encodeURIComponent(otpPhone)}&Code=${code}`,
      });
      const result: any = await resp.json();
      if (result.status === "approved") {
        console.log(`[Orchestrator] OTP verified for ${phone}`);
        const firstName = getFirstName(ctx);
        const nextDoc = getNextExpectedDoc([...(ctx.docsCollected || []), ...(ctx.skippedDocs || [])]);
        return {
          response: `Celular verificado ✓\n\n${firstName}, ¿tienes tu *${nextDoc?.label || 'siguiente documento'}* a la mano? 📷`,
          newState: state,
          contextUpdates: { otpVerified: true },
        };
      } else {
        return {
          response: "Ese código no es correcto. Revísalo e intenta de nuevo.",
          newState: state,
          contextUpdates: {},
        };
      }
    } catch (e: any) {
      console.error(`[Orchestrator] OTP verify failed:`, e.message);
    }
  }

  // ── Pre-NLU overrides (critical fixes) ──
  const override = preNluOverride(body, state);

  // ── NLU ──
  const nlu = override || await extractIntent(body, state);
  console.log(`[Orchestrator] NLU: intent=${nlu.intent} confidence=${nlu.confidence} entities=${JSON.stringify(nlu.entities)} override=${!!override}`);

  // ── CRITICAL: Greeting/fresh-start detection in advanced state → reset to idle ──
  // A message that STARTS with "hola"/"buenos días"/etc while deep in the flow means fresh start
  const ADVANCED_STATES: string[] = [
    "prospect_corrida", "prospect_confirm",
    "docs_capture", "docs_pending",
    "interview_ready", "interview_q1", "interview_q2", "interview_q3",
    "interview_q4", "interview_q5", "interview_q6", "interview_q7", "interview_q8",
    "interview_complete", "completed",
  ];
  const startsWithGreeting = /^\s*(hola|buenos?\s+(?:d[ií]as?|tardes?|noches?)|buenas|hey|qu[eé]\s+tal|que\s+tal|oye|oiga|buen\s+d[ií]a)/i.test(body);
  if ((nlu.intent === "greeting" || startsWithGreeting) && ADVANCED_STATES.includes(state)) {
    console.log(`[Orchestrator] Greeting in advanced state ${state} → welcome_back`);
    const firstName = getFirstName(ctx);
    const collectedDocs = ctx.docsCollected || [];
    const interviewDone = (ctx.interviewState?.currentQuestion || 0) >= 8;
    const nextDoc = getNextExpectedDoc([...collectedDocs, ...(ctx.skippedDocs || [])]);
    const nextDocLabel = nextDoc?.label || null;
    // Reset skipped docs so they can re-send
    const { welcome_back } = await import('./templates');
    return {
      response: welcome_back(firstName, nextDocLabel, interviewDone, collectedDocs.length, TOTAL_DOCS),
      newState: state.startsWith("interview_") && !state.includes("complete") ? "docs_pending" as ProspectState : state as ProspectState,
      contextUpdates: { skippedDocs: [] },
    };
  }

  // ── Check for off-flow questions (any state except idle/prospect_name) ──
  if (nlu.intent === "ask_question" && state !== "idle" && state !== "prospect_name") {
    const question = nlu.entities.question || body;
    const isHumanRequest = /hablar con persona|promotor|asesor|en persona/i.test(question);

    if (isHumanRequest) {
      // Notify promotora so they can reach out
      const folio = ctx.folio || '?';
      const nombre = ctx.nombre || phone;
      try {
        await notifyTeam(`📲 *Prospecto solicita atención personal*\n\n*Nombre:* ${nombre}\n*Tel:* ${phone}\n*Folio:* ${folio}\n\nFavor de contactarlo directamente.`);
      } catch (e: any) {
        console.error('[Orchestrator] notifyTeam (human request) failed:', e.message);
      }
      return {
        response: `Listo, ${ctx.nombre ? ctx.nombre.split(' ')[0] : 'amigo/a'}, le aviso a tu asesor(a) para que te contacte personalmente.\n\nMientras tanto, si tienes documentos a la mano puedes irlos mandando aquí — yo los guardo en tu expediente.`,
        newState: state,
        contextUpdates: {},
      };
    }

    const answer = await answerQuestion(question);
    if (answer) {
      return { response: answer, newState: state, contextUpdates: {} };
    }
    // If RAG has no answer, fall through to state handler
  }

  // ── State dispatch ──
  switch (state) {
    case "idle":
      return handleIdle(phone, body, nlu, ctx, storage);

    case "prospect_name":
      return handleProspectName(phone, body, nlu, ctx);

    case "prospect_fuel_type":
      return handleFuelType(phone, nlu, ctx);

    case "prospect_consumo":
      return handleConsumo(phone, body, nlu, ctx);

    case "prospect_select_model":
      return handleModelSelection(phone, body, nlu, ctx);

    case "prospect_tank":
      return handleTankDecision(phone, body, nlu, ctx);

    case "prospect_corrida":
      return handleCorridaResponse(phone, body, nlu, ctx, storage);

    case "prospect_confirm":
      return handleProspectConfirm(phone, body, nlu, ctx, storage);

    case "docs_capture":
    case "docs_pending":
      return handleDocsText(phone, body, nlu, ctx, state, storage);

    case "interview_ready":
      return handleInterviewReady(phone, nlu, ctx);

    case "interview_q1":
    case "interview_q2":
    case "interview_q3":
    case "interview_q4":
    case "interview_q5":
    case "interview_q6":
    case "interview_q7":
    case "interview_q8":
      return handleInterviewTextAnswer(phone, body, state, ctx, storage);

    case "interview_complete":
      return handleInterviewCompleteText(phone, body, nlu, ctx, state, storage);

    case "completed":
      return handleCompletedText(phone, body, nlu, ctx, storage);

    default:
      return handleIdle(phone, body, nlu, ctx, storage);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAudioMessage(
  phone: string,
  mediaUrl: string,
  state: ProspectState,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  // Download and transcribe
  let transcript: string;
  let audioBuffer: Buffer;
  try {
    audioBuffer = await downloadTwilioMedia(mediaUrl);
    transcript = await transcribeAudio(audioBuffer);
    console.log(`[Orchestrator] Whisper transcript: "${transcript.slice(0, 100)}"`);
  } catch (error: any) {
    console.error(`[Orchestrator] Audio processing failed:`, error.message);
    return {
      response: "No pude procesar tu nota de voz. ¿Puedes intentar de nuevo o escribir tu respuesta?",
      newState: state,
      contextUpdates: {},
    };
  }

  if (!transcript || transcript.trim().length === 0) {
    return {
      response: "No pude escuchar tu nota de voz. ¿Puedes intentar de nuevo?",
      newState: state,
      contextUpdates: {},
    };
  }

  // If in interview state → process as interview answer (voice)
  if (state.startsWith("interview_q")) {
    return handleInterviewVoiceAnswer(phone, transcript, audioBuffer.length, state, ctx, storage);
  }

  // Otherwise, treat transcript as text
  return handleTextMessage(phone, transcript, state, ctx, storage);
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleImageMessage(
  phone: string,
  mediaUrl: string,
  mediaType: string,
  state: ProspectState,
  ctx: AgentContext,
  body: string,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  // ── Process images during docs_capture, docs_pending, interview_complete, or completed (with pending docs) ──
  if (state === "docs_capture" || state === "docs_pending" || state === "interview_complete" || state === "completed") {
    return processDocImage(phone, mediaUrl, mediaType, state, ctx, body, storage);
  }

  // If they're sending an image before the docs stage, acknowledge and continue flow
  if (state === "idle" || state === "prospect_name" || state === "prospect_fuel_type") {
    return handleTextMessage(phone, body || "", state, ctx, storage);
  }

  return {
    response: "Recibí tu imagen, pero ahorita no estamos en la etapa de documentos. " + fallback_no_understand(),
    newState: state,
    contextUpdates: {},
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT IMAGE PROCESSOR
// ═══════════════════════════════════════════════════════════════════════════════

async function processDocImage(
  phone: string,
  mediaUrl: string,
  mediaType: string,
  state: ProspectState,
  ctx: AgentContext,
  body: string,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const firstName = getFirstName(ctx);

  // Download image from Twilio
  let imageBuffer: Buffer;
  try {
    imageBuffer = await downloadTwilioMedia(mediaUrl);
  } catch (error: any) {
    console.error(`[Orchestrator] Image download failed:`, error.message);
    return { response: fallback_state_error(), newState: state, contextUpdates: {} };
  }

  const imageBase64 = imageBuffer.toString("base64");

  // Determine expected document
  const collectedDocs = ctx.docsCollected || [];
  const nextDoc = getNextExpectedDoc([...collectedDocs, ...(ctx.skippedDocs || [])]);

  if (!nextDoc) {
    // All docs already collected — check if interview done
    const interviewDone = ctx.interviewState?.currentQuestion === 8;
    if (interviewDone) {
      return {
        response: already_complete(),
        newState: "completed" as ProspectState,
        contextUpdates: {},
      };
    }
    return {
      response: doc_all_complete(firstName),
      newState: state === "interview_complete" ? "interview_complete" as ProspectState : "interview_ready" as ProspectState,
      contextUpdates: {},
    };
  }

  // Classify and validate with Vision
  const visionResult = await classifyAndValidateDoc(
    imageBase64,
    nextDoc.key,
    DOC_ORDER,
    ctx.existingData || {},
  );

  console.log(`[Orchestrator] Vision: detected=${visionResult.detected_type} expected=${nextDoc.key} legible=${visionResult.is_legible} confidence=${visionResult.confidence}`);

  // ── Not legible ──
  if (!visionResult.is_legible) {
    return {
      response: doc_invalid(nextDoc.label, visionResult.rejection_reason || "La imagen no se ve bien. ¿Puedes tomarla con más luz?"),
      newState: state,
      contextUpdates: {},
    };
  }

  // ── Unknown type ──
  if (visionResult.detected_type === "unknown") {
    return {
      response: doc_invalid(nextDoc.label, visionResult.rejection_reason || "No reconozco este documento."),
      newState: state,
      contextUpdates: {},
    };
  }

  // ── Detected a valid doc type ──
  const detectedKey = visionResult.detected_type;
  const detectedLabel = DOC_LABELS[detectedKey] || detectedKey;

  // ── Multi-ticket accumulation for GNV / gasolina (up to 3 tickets) ──
  const isTicketDoc = detectedKey === 'historial_gnv' || detectedKey === 'tickets_gasolina';
  const ticketField = detectedKey === 'historial_gnv' ? 'gnvTickets' : 'gasolinaTickets';
  const MIN_TICKETS = 3;

  if (isTicketDoc) {
    const existing = (ctx[ticketField as keyof typeof ctx] as Array<any>) || [];
    const newTicket = {
      litros: visionResult.extracted_data?.litros ? parseFloat(visionResult.extracted_data.litros) : undefined,
      monto: visionResult.extracted_data?.monto ? parseFloat(String(visionResult.extracted_data.monto).replace(/[,$]/g, '')) : undefined,
      fecha: visionResult.extracted_data?.fecha || undefined,
    };
    const updatedTickets = [...existing, newTicket];
    const ticketCount = updatedTickets.length;
    const detectedLabel2 = detectedKey === 'historial_gnv' ? 'Ticket GNV' : 'Ticket Gasolina';

    // Calculate average
    const litrosValues = updatedTickets.map(t => t.litros).filter((v): v is number => typeof v === 'number' && v > 0);
    const montoValues = updatedTickets.map(t => t.monto).filter((v): v is number => typeof v === 'number' && v > 0);
    const avgLitros = litrosValues.length > 0 ? Math.round(litrosValues.reduce((a, b) => a + b, 0) / litrosValues.length) : null;
    const avgMonto = montoValues.length > 0 ? Math.round(montoValues.reduce((a, b) => a + b, 0) / montoValues.length) : null;

    const contextUpTicket: Partial<AgentContext> = {
      [ticketField]: updatedTickets,
      existingData: { ...ctx.existingData, [`_${detectedKey}_data`]: visionResult.extracted_data },
    };

    if (ticketCount < MIN_TICKETS) {
      // Need more tickets
      const remaining = MIN_TICKETS - ticketCount;
      return {
        response: `*${detectedLabel2} #${ticketCount}* recibido \u2713\n\nNecesito *${remaining} ticket${remaining > 1 ? 's' : ''} m\u00e1s* (3 en total). Manda el siguiente. \uD83D\uDCF7`,
        newState: state,
        contextUpdates: contextUpTicket,
      };
    }

    // Have 3+ tickets — compute monthly estimate (avg/ticket × 26 working days)
    const newCollectedTicket = [...collectedDocs];
    if (!newCollectedTicket.includes(detectedKey)) newCollectedTicket.push(detectedKey);

    // Internal flags for director/evaluation (NOT shown to prospect)
    const internalFlags: string[] = [];
    let prospectMsg = '';

    if (detectedKey === 'historial_gnv' && avgLitros !== null) {
      const monthlyLeq = Math.round(avgLitros * 26);
      if (monthlyLeq < 300) internalFlags.push('consumo_bajo_gnv');
      prospectMsg = `Consumo estimado: *${monthlyLeq} LEQ/mes* \u2713`;
      // Save monthly estimate to existingData for use in evaluation
      contextUpTicket.existingData = { ...contextUpTicket.existingData, gnv_leq_mensual: monthlyLeq };
    } else if (detectedKey === 'tickets_gasolina' && avgMonto !== null) {
      const monthlyMonto = Math.round(avgMonto * 26);
      if (monthlyMonto < 6000) internalFlags.push('gasto_bajo_gasolina');
      prospectMsg = `Gasto estimado: *$${monthlyMonto.toLocaleString()}/mes* \u2713`;
      contextUpTicket.existingData = { ...contextUpTicket.existingData, gasolina_monto_mensual: monthlyMonto };
    }

    // Store flags internally (director sees them in evaluation, prospect does not)
    if (internalFlags.length > 0) {
      contextUpTicket.existingData = { ...contextUpTicket.existingData, _ticket_flags: internalFlags };
    }

    const nextDocTicket = getNextExpectedDoc([...newCollectedTicket, ...(ctx.skippedDocs || [])]);

    // Flush ticket summary → originations.datos_historial
    flushOCRToOrigination(phone, detectedKey, {
      tickets: updatedTickets,
      ...(detectedKey === 'historial_gnv' && avgLitros ? { gnv_leq_mensual: Math.round(avgLitros * 26), avg_leq_ticket: avgLitros } : {}),
      ...(detectedKey === 'tickets_gasolina' && avgMonto ? { gasolina_monto_mensual: Math.round(avgMonto * 26), avg_monto_ticket: avgMonto } : {}),
      _ticket_flags: internalFlags,
    }).catch(() => {});

    return {
      response: `*${detectedLabel2} #${ticketCount}* recibido \u2713 — Tengo los *3 tickets*.\n\n${prospectMsg}\n\n${
        nextDocTicket ? `Manda tu *${nextDocTicket.label}* \uD83D\uDCF7` : 'Todos los documentos listos.'
      }`,
      newState: nextDocTicket ? state : ('interview_ready' as ProspectState),
      contextUpdates: { ...contextUpTicket, docsCollected: newCollectedTicket },
    };
  }

  // Accept it for its correct slot (even if different from expected)
  const newCollected = [...collectedDocs];
  if (!newCollected.includes(detectedKey)) {
    newCollected.push(detectedKey);
  }

  // Merge extracted data
  const newExistingData = {
    ...ctx.existingData,
    ...visionResult.extracted_data,
    [`_${detectedKey}_data`]: visionResult.extracted_data,
  };

  console.log(`[Orchestrator] Vision extracted_data:`, JSON.stringify(visionResult.extracted_data).slice(0, 300));

  const contextUp: Partial<AgentContext> = {
    docsCollected: newCollected,
    existingData: newExistingData,
    currentDocIndex: (ctx.currentDocIndex || 0) + 1,
  };

  // ── CRITICAL: Cross-check INE nombre vs prospect nombre ──
  if (detectedKey === 'ine_frente' && visionResult.extracted_data) {
    const ineNombre = (visionResult.extracted_data.nombre || '').toUpperCase().trim();
    const prospectNombre = (ctx.nombre || '').toUpperCase().trim();
    if (ineNombre && prospectNombre) {
      // Compare first word (apellido or nombre) for basic match
      const ineWords = ineNombre.split(/\s+/);
      const prospectWords = prospectNombre.split(/\s+/);
      const anyMatch = prospectWords.some((w: string) => w.length > 2 && ineWords.includes(w));
      if (!anyMatch) {
        // Name on INE doesn't match prospect's stated name AT ALL
        if (!visionResult.cross_check_flags.includes('nombre_prospecto_mismatch')) {
          visionResult.cross_check_flags.push('nombre_prospecto_mismatch');
        }
      }
    }
  }

  // ── INE frente: update prospect name from official document ──
  if (detectedKey === 'ine_frente' && visionResult.extracted_data) {
    const ineNombre = visionResult.extracted_data.nombre || visionResult.extracted_data.nombre_completo;
    if (ineNombre && ineNombre.trim()) {
      const oldName = ctx.nombre || '';
      const newName = ineNombre.trim();
      contextUp.nombre = newName;

      if (ctx.folio) {
        try {
          const sql = getSQL();
          await sql`UPDATE originations SET nombre = ${newName} WHERE folio = ${ctx.folio}`;
        } catch (e: any) {
          console.error('[Orchestrator] Failed to update folio name:', e.message);
        }
      }

      if (oldName && oldName.toUpperCase() !== newName.toUpperCase()) {
        try {
          await notifyTeam(`⚠️ Nombre cambiado: "${oldName}" → "${newName}" (INE) | Folio: ${ctx.folio || '?'}`);
        } catch (e: any) {
          console.error('[Orchestrator] notifyTeam failed:', e.message);
        }
      }
    }
  }

  // ── OTP: Send verification code after INE frente captured ──
  if (detectedKey === 'ine_frente' && !ctx.otpSent) {
    try {
      const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID || "VAb7b31cdc560d238ed2bd90da259b9a12";
      const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || "";
      const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
      if (TWILIO_SID && TWILIO_TOKEN && TWILIO_VERIFY_SID) {
        const authHeader = "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
        const otpPhone = phone.startsWith("+") ? phone : `+${phone}`;
        await fetch(`https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SID}/Verifications`, {
          method: "POST",
          headers: { "Authorization": authHeader, "Content-Type": "application/x-www-form-urlencoded" },
          body: `To=${encodeURIComponent(otpPhone)}&Channel=sms`,
        });
        contextUp.otpSent = true;
        console.log(`[Orchestrator] OTP sent to ${otpPhone}`);
      }
    } catch (e: any) {
      console.error(`[Orchestrator] OTP send failed:`, e.message);
    }
  }

  // Save document to DB (documents table + originations structured columns)
  if (ctx.originationId) {
    await saveDocument(
      ctx.originationId,
      detectedKey,
      detectedLabel,
      visionResult.extracted_data,
      mediaUrl,
      visionResult.cross_check_flags,
    );
  }
  // Always flush OCR → originations.datos_* (fire-and-forget, no-op if no folio)
  flushOCRToOrigination(phone, detectedKey, visionResult.extracted_data || {}).catch(() => {});

  // Update pipeline docs count
  try {
    await updateProspectDocs(phone, newCollected.length, TOTAL_DOCS);
  } catch (error: any) {
    console.error(`[Orchestrator] updateProspectDocs failed:`, error.message);
  }

  // Check next doc after this one
  const nextDocAfter = getNextExpectedDoc([...newCollected, ...(ctx.skippedDocs || [])]);

  if (!nextDocAfter) {
    const actualPending = TOTAL_DOCS - newCollected.length;

    if (actualPending > 0) {
      // Remaining docs were all skipped — re-present them
      const firstPending = getNextExpectedDoc(newCollected); // without skipped
      if (firstPending) {
        contextUp.skippedDocs = [];
        return {
          response: `*${detectedLabel}* recibido ✓ (${newCollected.length}/${TOTAL_DOCS})\n\n${firstName}, te faltan *${actualPending} documentos* por capturar. Los que saltaste los puedes mandar ahora.\n\nMándame tu *${firstPending.label}* 📷`,
          newState: "docs_pending" as ProspectState,
          contextUpdates: contextUp,
        };
      }
    }

    // All docs truly complete!
    try {
      await notifyTeam(`Documentos completos: ${ctx.folio || "?"} — ${ctx.nombre || "?"}`);
    } catch (e: any) {
      console.error("[Orchestrator] notifyTeam failed:", e.message);
    }

    const interviewDone = ctx.interviewState?.currentQuestion === 8;

    if (interviewDone) {
      // Both docs and interview done → all_complete
      try { await updateProspectStatus(phone, "expediente_completo"); } catch (e: any) { console.error(e.message); }
      return {
        response: doc_status(firstName, newCollected.length, TOTAL_DOCS, [], true),
        newState: "completed" as ProspectState,
        contextUpdates: contextUp,
      };
    }

    return {
      response: doc_all_complete(firstName),
      newState: state === "interview_complete" ? "interview_complete" as ProspectState : "interview_ready" as ProspectState,
      contextUpdates: contextUp,
    };
  }

  // After INE frente → add OTP prompt to response
  let otpPrompt = "";
  if (detectedKey === "ine_frente" && !ctx.otpVerified && contextUp.otpSent) {
    otpPrompt = "\n\n📱 Te mandé un *código de 6 dígitos* por SMS para verificar tu celular. Escríbelo aquí.";
  }

  // Build response with extracted data summary — show ALL non-null fields
  const extractedSummary = Object.entries(visionResult.extracted_data || {})
    .filter(([k, v]) => v !== null && v !== undefined && v !== '' && v !== 'null' && !k.startsWith('_'))
    .map(([k, v]) => {
      const val = String(v);
      // Truncate very long values
      return `${k}: ${val.length > 40 ? val.slice(0, 40) + '...' : val}`;
    })
    .join(' | ');
  const dataSummaryLine = extractedSummary ? `\n_Datos: ${extractedSummary}_` : '';

  // Import doc explanation for next doc
  const { doc_request_with_explanation } = await import('./templates');
  const nextDocExplanation = doc_request_with_explanation(nextDocAfter.key, nextDocAfter.label, newCollected.length + 1, TOTAL_DOCS);

  let responseText: string;
  if (!visionResult.matches_expected && detectedKey !== nextDoc.key) {
    responseText = `*${detectedLabel}* recibido \u2713 (${newCollected.length}/${TOTAL_DOCS})${dataSummaryLine}\n\n${nextDocExplanation}`;
  } else {
    responseText = `*${detectedLabel}* recibido \u2713 (${newCollected.length}/${TOTAL_DOCS})${dataSummaryLine}\n\n${nextDocExplanation}`;
  }

  // Cross-check: REJECTION flags vs WARNING flags
  if (visionResult.cross_check_flags.length > 0) {
    const flags = visionResult.cross_check_flags;

    // ── REJECTION flags → document NOT accepted ──
    const REJECTION_FLAGS: Record<string, string> = {
      'tipo_no_taxi': 'Esta concesi\u00f3n NO es de taxi. Solo aceptamos concesiones de *taxi*. Si tienes una concesi\u00f3n de taxi, m\u00e1ndala.',
      'no_es_taxi': 'Esta tarjeta de circulaci\u00f3n no es de servicio p\u00fablico/taxi. Necesitamos la tarjeta del *taxi*, no de un veh\u00edculo particular.',
      'municipio_no_ags': 'Esta concesi\u00f3n no es de Aguascalientes. Solo operamos en *Aguascalientes*.',
    };

    for (const [flagKey, rejectionMsg] of Object.entries(REJECTION_FLAGS)) {
      if (flags.includes(flagKey)) {
        // REJECT: remove from collected, don't save
        const rejectedIdx = newCollected.indexOf(detectedKey);
        if (rejectedIdx !== -1) newCollected.splice(rejectedIdx, 1);
        return {
          response: `\u274c ${rejectionMsg}`,
          newState: state as ProspectState,
          contextUpdates: { docsCollected: newCollected },
        };
      }
    }

    // ── WARNING flags → accepted but flagged ──
    const warnings: string[] = [];
    if (flags.includes('nombre_prospecto_mismatch')) warnings.push('El nombre en tu INE no coincide con el nombre que me diste. \u00bfLa INE es tuya?');
    if (flags.includes('nombre_mismatch')) warnings.push('El nombre en este documento no coincide con tu INE. \u00bfEs tuyo?');
    if (flags.includes('expired') || flags.includes('vigencia_vencida') || flags.includes('ine_vencida')) warnings.push('Este documento parece estar vencido.');
    if (flags.includes('curp_mismatch')) warnings.push('La CURP no coincide con la de tu INE.');
    if (flags.includes('domicilio_mismatch')) warnings.push('La direcci\u00f3n no coincide con la de tu INE. Necesitamos que el domicilio sea el mismo en INE, comprobante y estado de cuenta.');
    if (flags.includes('address_mismatch')) warnings.push('La direcci\u00f3n no coincide con la de tu INE.');
    if (flags.includes('domicilio_vencido')) warnings.push('Este comprobante tiene m\u00e1s de 3 meses. Necesitamos uno m\u00e1s reciente.');
    if (flags.includes('csf_vencida')) warnings.push('Tu CSF tiene m\u00e1s de 30 d\u00edas. Saca una nueva en el portal del SAT.');
    if (flags.includes('clabe_invalid')) warnings.push('La CLABE no tiene 18 d\u00edgitos. Verifica tu estado de cuenta.');
    if (flags.includes('niv_mismatch')) warnings.push('El NIV/n\u00famero de serie no coincide con tu tarjeta de circulaci\u00f3n.');
    if (flags.includes('placa_mismatch')) warnings.push('La placa no coincide con tu tarjeta de circulaci\u00f3n.');
    if (flags.includes('ine_operador_vencida')) warnings.push('La INE del operador est\u00e1 vencida.');
    if (flags.includes('licencia_vencida')) warnings.push('La licencia de conducir est\u00e1 vencida.');
    if (flags.includes('rostro_no_coincide')) warnings.push('El rostro en la selfie no parece coincidir con la foto de tu INE.');
    if (flags.includes('consumo_bajo_gnv')) warnings.push('Tu consumo de GNV parece bajo (< 300 LEQ/mes).');
    if (flags.includes('gasto_bajo_gasolina')) warnings.push('Tu gasto de gasolina parece bajo (< $6,000/mes).');
    // Catch any unhandled flags
    const handledFlags = ['nombre_prospecto_mismatch','nombre_mismatch','expired','vigencia_vencida','ine_vencida','curp_mismatch','domicilio_mismatch','address_mismatch','domicilio_vencido','csf_vencida','clabe_invalid','niv_mismatch','placa_mismatch','ine_operador_vencida','licencia_vencida','rostro_no_coincide','consumo_bajo_gnv','gasto_bajo_gasolina','tipo_no_taxi','no_es_taxi','municipio_no_ags'];
    const unhandled = flags.filter((f: string) => !handledFlags.includes(f));
    if (unhandled.length > 0 && warnings.length === 0) warnings.push(unhandled.join(', '));

    if (warnings.length > 0) {
      responseText = `\u26a0\ufe0f ${warnings.join('\n\u26a0\ufe0f ')}\n\n${responseText}`;
    }
  }

  // Stay in same state (docs_capture, docs_pending, or interview_complete)
  return {
    response: responseText,
    newState: state as ProspectState,
    contextUpdates: contextUp,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

// ── IDLE → greeting + ask name ──

async function handleIdle(
  phone: string,
  body: string,
  nlu: NLUResult,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  // Detect canal from first message
  const canal = detectCanal(body);

  // Upsert prospect
  try {
    await upsertProspect({
      phone,
      canal_origen: canal,
      status: "curioso",
    });
  } catch (error: any) {
    console.error(`[Orchestrator] upsertProspect failed:`, error.message);
  }

  // Block human-escalation phrases from being accepted as names
  const isHumanRequestIdle = /\b(con[eé]ct[ae]me?|quiero\s+(?:hablar|platicar)|hablar\s+con|\bpromotor[ae]?\b|\basesor[ae]?\b|en\s+persona|una\s+persona|alguien\s+real)\b/i.test(body);
  if (isHumanRequestIdle) {
    try {
      await notifyTeam(`📲 *Prospecto solicita atención personal*\n\n*Tel:* ${phone}\n*Folio:* Sin folio aún\n\nFavor de contactarlo directamente.`);
    } catch (e: any) {
      console.error('[Orchestrator] notifyTeam (human idle) failed:', e.message);
    }
    return {
      response: `Claro, le aviso a tu asesor(a) para que te contacte.\n\n¿Me dices tu nombre para que sepa a quién buscar?`,
      newState: "prospect_name" as ProspectState,
      contextUpdates: { canal },
    };
  }

  // If they already give their name in the first message, accept it
  if (nlu.intent === "give_name" && nlu.entities.nombre) {
    const nombre = nlu.entities.nombre;
    const firstName = nombre.split(" ")[0];

    try {
      await upsertProspect({ phone, nombre, status: "interesado" });
    } catch (error: any) {
      console.error(`[Orchestrator] upsertProspect failed:`, error.message);
    }

    return {
      response: program_context(nombre),
      newState: "prospect_fuel_type",
      contextUpdates: { canal, nombre, profileName: ctx.profileName },
    };
  }

  // Default: greeting + ask name
  return {
    response: greeting(ctx.profileName || ""),
    newState: "prospect_name",
    contextUpdates: { canal },
  };
}

// ── PROSPECT_NAME → receive name → explain program + ask fuel type ──

async function handleProspectName(
  phone: string,
  body: string,
  nlu: NLUResult,
  ctx: AgentContext,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  // Check if user is asking for a human before we accept their text as a name
  const isHumanRequest = /\b(con[eé]ct[ae]me?|quiero\s+(?:hablar|platicar)|hablar\s+con|promotor[ae]?|asesor[ae]?|en\s+persona|una\s+persona|alguien\s+real)\b/i.test(body);
  if (isHumanRequest) {
    try {
      await notifyTeam(`📲 *Prospecto solicita atención personal*\n\n*Tel:* ${phone}\n*Folio:* Sin folio aún\n\nFavor de contactarlo directamente.`);
    } catch (e: any) {
      console.error('[Orchestrator] notifyTeam (human request - prospect_name) failed:', e.message);
    }
    return {
      response: `Claro, le aviso a tu asesor(a) para que te contacte. \u00bfMe dices tu nombre para que sepa a quién buscar?`,
      newState: 'prospect_name' as ProspectState,
      contextUpdates: {},
    };
  }

  // Check for name intent
  if (nlu.intent === "give_name" && nlu.entities.nombre) {
    const nombre = nlu.entities.nombre;
    try {
      await upsertProspect({ phone, nombre, status: "interesado" });
    } catch (error: any) {
      console.error(`[Orchestrator] upsertProspect failed:`, error.message);
    }

    return {
      response: program_context(nombre),
      newState: "prospect_fuel_type",
      contextUpdates: { nombre },
    };
  }

  // If body looks like a name (2+ words, letters only) — accept it even without NLU match
  const cleanBody = body.trim();
  const words = cleanBody.split(/\s+/);
  if (words.length >= 2 && /^[A-ZÁÉÍÓÚÑa-záéíóúñ\s]+$/.test(cleanBody) && cleanBody.length >= 4) {
    const nombre = cleanBody;
    try {
      await upsertProspect({ phone, nombre, status: "interesado" });
    } catch (error: any) {
      console.error(`[Orchestrator] upsertProspect failed:`, error.message);
    }

    return {
      response: program_context(nombre),
      newState: "prospect_fuel_type",
      contextUpdates: { nombre },
    };
  }

  // Single word → accept as first name (many people just say "Juan")
  if (words.length === 1 && /^[A-ZÁÉÍÓÚÑa-záéíóúñ]{2,}$/.test(cleanBody)) {
    const nombre = cleanBody;
    try {
      await upsertProspect({ phone, nombre, status: "interesado" });
    } catch (error: any) {
      console.error(`[Orchestrator] upsertProspect failed:`, error.message);
    }

    return {
      response: program_context(nombre),
      newState: "prospect_fuel_type",
      contextUpdates: { nombre },
    };
  }

  if (nlu.intent === "deny" || nlu.intent === "maybe_later") {
    return { response: cold_goodbye(getFirstName(ctx)), newState: "idle", contextUpdates: {} };
  }

  // Handle questions
  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || body);
    if (answer) {
      return { response: answer + "\n\n¿Cómo te llamas?", newState: "prospect_name", contextUpdates: {} };
    }
  }

  return {
    response: "Para atenderte mejor, ¿cómo te llamas?",
    newState: "prospect_name",
    contextUpdates: {},
  };
}

// ── PROSPECT_FUEL_TYPE → GNV or gasolina ──

async function handleFuelType(
  phone: string,
  nlu: NLUResult,
  ctx: AgentContext,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const firstName = getFirstName(ctx);

  if (nlu.intent === "fuel_gnv") {
    try {
      await upsertProspect({ phone, fuel_type: "gnv", status: "interesado" });
    } catch (error: any) {
      console.error(`[Orchestrator] upsertProspect failed:`, error.message);
    }
    return {
      response: ask_consumo_gnv(firstName),
      newState: "prospect_consumo",
      contextUpdates: { fuelType: "gnv" },
    };
  }

  if (nlu.intent === "fuel_gasolina") {
    try {
      await upsertProspect({ phone, fuel_type: "gasolina", status: "interesado" });
    } catch (error: any) {
      console.error(`[Orchestrator] upsertProspect failed:`, error.message);
    }
    return {
      response: ask_consumo_gasolina(firstName),
      newState: "prospect_consumo",
      contextUpdates: { fuelType: "gasolina" },
    };
  }

  // Handle questions
  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || "");
    if (answer) {
      return {
        response: answer + "\n\n¿Tu taxi usa *gas natural* o *gasolina*?",
        newState: "prospect_fuel_type",
        contextUpdates: {},
      };
    }
  }

  if (nlu.intent === "deny" || nlu.intent === "maybe_later") {
    return { response: cold_goodbye(firstName), newState: "idle", contextUpdates: {} };
  }

  return {
    response: `${firstName}, para calcularte los números necesito saber: ¿tu taxi usa *gas natural* o *gasolina*?`,
    newState: "prospect_fuel_type",
    contextUpdates: {},
  };
}

// ── PROSPECT_CONSUMO → LEQ/month → show 5 models ──

async function handleConsumo(
  phone: string,
  body: string,
  nlu: NLUResult,
  ctx: AgentContext,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const firstName = getFirstName(ctx);
  let leq = 0;
  let gastoPesos = 0;
  let hasConsumo = false;

  if (nlu.intent === "consumo_number" && nlu.entities.leq) {
    leq = nlu.entities.leq;
    if (leq < 50 || leq > 3000) {
      return { response: consumo_out_of_range(), newState: "prospect_consumo", contextUpdates: {} };
    }
    hasConsumo = true;
  } else if (nlu.intent === "gasto_number" && nlu.entities.pesos) {
    gastoPesos = nlu.entities.pesos;
    if (gastoPesos < 500 || gastoPesos > 30000) {
      return { response: gasto_out_of_range(), newState: "prospect_consumo", contextUpdates: {} };
    }
    leq = pesosToLeq(gastoPesos);
    hasConsumo = true;
  }

  if (hasConsumo && leq > 0) {
    // Update prospect
    try {
      await upsertProspect({ phone, consumo_mensual: leq });
    } catch (error: any) {
      console.error(`[Orchestrator] upsertProspect failed:`, error.message);
    }

    // Build model summaries
    const { summaries, recaudo } = await buildModelSummaries(leq);

    if (summaries.length === 0) {
      return {
        response: no_models_available(),
        newState: "prospect_consumo",
        contextUpdates: { consumoLeq: leq, gastoPesosMes: gastoPesos > 0 ? gastoPesos : undefined },
      };
    }

    return {
      response: show_models(firstName, leq, recaudo, summaries),
      newState: "prospect_select_model",
      contextUpdates: { consumoLeq: leq, gastoPesosMes: gastoPesos > 0 ? gastoPesos : undefined },
    };
  }

  // Handle questions
  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || body);
    if (answer) {
      const askAgain = ctx.fuelType === "gasolina" ? ask_consumo_gasolina(firstName) : ask_consumo_gnv(firstName);
      return { response: answer + "\n\n" + askAgain, newState: "prospect_consumo", contextUpdates: {} };
    }
  }

  if (nlu.intent === "deny" || nlu.intent === "maybe_later") {
    return { response: cold_goodbye(firstName), newState: "idle", contextUpdates: {} };
  }

  // Can't parse → ask again
  const askAgain = ctx.fuelType === "gasolina" ? ask_consumo_gasolina(firstName) : ask_consumo_gnv(firstName);
  return { response: fallback_no_understand() + "\n\n" + askAgain, newState: "prospect_consumo", contextUpdates: {} };
}

// ── PROSPECT_SELECT_MODEL → pick model ──

async function handleModelSelection(
  phone: string,
  body: string,
  nlu: NLUResult,
  ctx: AgentContext,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const firstName = getFirstName(ctx);

  // Select a specific model
  if (nlu.intent === "select_model" && nlu.entities.modelo) {
    return selectModelAndAdvance(nlu.entities.modelo, ctx, firstName);
  }

  // Want to see all models again
  if (nlu.intent === "see_all_models") {
    const leq = ctx.consumoLeq || BASE_LEQ;
    const { summaries, recaudo } = await buildModelSummaries(leq);

    if (summaries.length === 0) {
      return { response: no_models_available(), newState: "prospect_select_model", contextUpdates: {} };
    }

    return {
      response: show_models(firstName, leq, recaudo, summaries),
      newState: "prospect_select_model",
      contextUpdates: {},
    };
  }

  // Try matching model name directly from body text
  const matched = matchModelFromText(body);
  if (matched) {
    return selectModelAndAdvance(matched.modelo, ctx, firstName);
  }

  // Handle questions
  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || body);
    if (answer) {
      return { response: answer + "\n\n¿Cuál modelo te interesa?", newState: "prospect_select_model", contextUpdates: {} };
    }
  }

  if (nlu.intent === "deny" || nlu.intent === "maybe_later") {
    return { response: cold_goodbye(firstName), newState: "idle", contextUpdates: {} };
  }

  return {
    response: "No encontré ese modelo. Los que tenemos son: Aveo, March Sense, March Advance, Kwid, i10. ¿Cuál te interesa?",
    newState: "prospect_select_model",
    contextUpdates: {},
  };
}

/**
 * Helper: select a model and advance to tank (GNV) or corrida (gasolina).
 */
async function selectModelAndAdvance(
  modeloText: string,
  ctx: AgentContext,
  firstName: string,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const matched = matchModelFromText(modeloText);
  if (!matched) {
    return {
      response: "No encontré ese modelo. Los que tenemos son: Aveo, March Sense, March Advance, Kwid, i10. ¿Cuál te interesa?",
      newState: "prospect_select_model",
      contextUpdates: {},
    };
  }

  const pv = await getPvForModel(matched.marca, matched.modelo, matched.anio);
  const modelName = `${matched.marca} ${matched.modelo} ${matched.anio}`;

  // Perfil A (GNV): ask about tank
  if (ctx.fuelType === "gnv") {
    return {
      response: ask_tank(modelName, pv),
      newState: "prospect_tank",
      contextUpdates: { selectedModel: matched, pvBase: pv },
    };
  }

  // Perfil B (gasolina): always new kit → go straight to corrida
  const pvWithKit = pv + KIT_NUEVO_COST;
  const leq = ctx.consumoLeq || BASE_LEQ;
  const corrida = generarCorridaEstimada(matched.modelo, matched.anio, pvWithKit, leq);
  const kitLabel = "_(Incluye kit de gas natural nuevo: +$9,400)_";

  return {
    response: show_corrida(corrida.resumenWhatsApp, kitLabel, firstName),
    newState: "prospect_corrida",
    contextUpdates: {
      selectedModel: matched,
      pvBase: pvWithKit,
      reuseTank: false,
      corridaResumen: corrida.resumenWhatsApp,
    },
  };
}

// ── PROSPECT_TANK → reuse tank or new? (GNV only) ──

async function handleTankDecision(
  phone: string,
  body: string,
  nlu: NLUResult,
  ctx: AgentContext,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const firstName = getFirstName(ctx);

  if (!ctx.selectedModel || !ctx.pvBase) {
    return { response: fallback_state_error(), newState: "prospect_select_model", contextUpdates: {} };
  }

  let reuse: boolean | null = null;

  // CRITICAL FIX #1: "1" is handled by preNluOverride → intent = reuse_tank
  if (nlu.intent === "reuse_tank" || nlu.intent === "affirm") {
    reuse = true;
  } else if (nlu.intent === "new_tank") {
    reuse = false;
  }

  if (reuse !== null) {
    const pv = reuse ? ctx.pvBase : ctx.pvBase + KIT_NUEVO_COST;
    const leq = ctx.consumoLeq || BASE_LEQ;
    const corrida = generarCorridaEstimada(
      ctx.selectedModel.modelo,
      ctx.selectedModel.anio,
      pv,
      leq,
    );

    const kitLabel = reuse
      ? "_(Reuso de tanque, sin costo extra)_"
      : `_(Kit de gas natural nuevo: +$${KIT_NUEVO_COST.toLocaleString()})_`;

    return {
      response: show_corrida(corrida.resumenWhatsApp, kitLabel, firstName),
      newState: "prospect_corrida",
      contextUpdates: {
        reuseTank: reuse,
        pvBase: pv,
        corridaResumen: corrida.resumenWhatsApp,
      },
    };
  }

  // Handle questions
  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || "");
    if (answer) {
      return {
        response: answer + "\n\n" + ask_tank(
          `${ctx.selectedModel.marca} ${ctx.selectedModel.modelo} ${ctx.selectedModel.anio}`,
          ctx.pvBase,
        ),
        newState: "prospect_tank",
        contextUpdates: {},
      };
    }
  }

  return {
    response: ask_tank(
      `${ctx.selectedModel.marca} ${ctx.selectedModel.modelo} ${ctx.selectedModel.anio}`,
      ctx.pvBase,
    ),
    newState: "prospect_tank",
    contextUpdates: {},
  };
}

// ── PROSPECT_CORRIDA → show corrida → "¿le entramos?" ──

async function handleCorridaResponse(
  phone: string,
  body: string,
  nlu: NLUResult,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const firstName = getFirstName(ctx);

  if (nlu.intent === "affirm" || nlu.intent === "want_register") {
    // Create folio immediately
    return createFolioAndAdvance(phone, ctx, storage);
  }

  if (nlu.intent === "deny") {
    return { response: cold_goodbye(firstName), newState: "idle", contextUpdates: {} };
  }

  if (nlu.intent === "maybe_later") {
    return {
      response: `Sin problema, ${firstName}. Cuando quieras retomar, escríbeme. El programa sigue abierto.`,
      newState: "idle",
      contextUpdates: {},
    };
  }

  // If they want to pick a different model
  if (nlu.intent === "select_model") {
    return selectModelAndAdvance(nlu.entities.modelo || body, ctx, firstName);
  }

  // Handle questions
  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || body);
    if (answer) {
      return {
        response: answer + "\n\n¿Le entramos?",
        newState: "prospect_corrida",
        contextUpdates: {},
      };
    }
  }

  return {
    response: `${firstName}, ¿le entramos al proceso? Son 14 documentos por foto + una entrevista rápida.`,
    newState: "prospect_corrida",
    contextUpdates: {},
  };
}

// ── Create Folio Helper ──

async function createFolioAndAdvance(
  phone: string,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {
  const firstName = getFirstName(ctx);
  const nombre = ctx.nombre || firstName;

  try {
    const { folio, originationId, taxistaId } = await createFolioFromWhatsApp(
      storage,
      phone,
      nombre,
      phone,
      "CONCESIONARIO",
    );

    try {
      await upsertProspect({
        phone,
        nombre,
        status: "registrado",
        folio_id: folio,
      });
    } catch (error: any) {
      console.error(`[Orchestrator] upsertProspect failed:`, error.message);
    }

    try {
      const modeloRaw = ctx.selectedModel || ctx.modelo;
      const modeloStr = modeloRaw && typeof modeloRaw === 'object'
        ? `${(modeloRaw as any).marca || ''} ${(modeloRaw as any).modelo || ''} ${(modeloRaw as any).anio || ''}`.trim()
        : ((modeloRaw as any) || '?');
      const consumo = ctx.consumoLeq || (ctx as any).consumo || 0;
      const combustible = ctx.fuelType || '?';
      const pvStr = (ctx as any).pvBase ? `$${((ctx as any).pvBase).toLocaleString()}` : '';
      await notifyTeam(`🆕 *Nuevo prospecto*\n\n*Folio:* ${folio}\n*Nombre:* ${nombre}\n*Tel:* ${phone}\n*Modelo:* ${modeloStr}${pvStr ? ' ' + pvStr : ''}\n*Combustible:* ${combustible}\n*Consumo:* ${consumo} LEQ/mes`);
    } catch (error: any) {
      console.error(`[Orchestrator] notifyTeam failed:`, error.message);
    }

    // Handoff: folio context persists in agent context so WhatsAppAgent (v9) can pick it up
    const contextUpdates: Partial<AgentContext> = {
      folio,
      originationId,
      taxistaId,
      docsCollected: [],
      currentDocIndex: 0,
      existingData: {},
    };

    console.log(`[Orchestrator] Folio created: ${folio} (originationId=${originationId}) for ${nombre} — handoff to docs_capture`);

    return {
      response: folio_created(firstName, folio),
      newState: "docs_capture" as ProspectState,
      contextUpdates,
    };
  } catch (error: any) {
    console.error(`[Orchestrator] createFolioFromWhatsApp failed:`, error.message);
    return {
      response: "Tuve un problema creando tu folio. Intenta de nuevo o escríbenos al 446 329 3102.",
      newState: "prospect_confirm",
      contextUpdates: {},
    };
  }
}

// ── PROSPECT_CONFIRM → yes → create folio → ask for INE ──

async function handleProspectConfirm(
  phone: string,
  body: string,
  nlu: NLUResult,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const firstName = getFirstName(ctx);

  // If they deny at the last moment
  if (nlu.intent === "deny") {
    return { response: cold_goodbye(firstName), newState: "idle", contextUpdates: {} };
  }

  if (nlu.intent === "maybe_later") {
    return {
      response: `Sin problema, ${firstName}. Cuando quieras retomar, escríbeme.`,
      newState: "idle",
      contextUpdates: {},
    };
  }

  // Any other message → create folio (they already confirmed in prospect_corrida)
  return createFolioAndAdvance(phone, ctx, storage);
}

// ── DOCS_CAPTURE / DOCS_PENDING → docs one by one ──

async function handleDocsText(
  phone: string,
  body: string,
  nlu: NLUResult,
  ctx: AgentContext,
  state: ProspectState,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const firstName = getFirstName(ctx);
  const collectedDocs = ctx.docsCollected || [];
  const interviewDone = ctx.interviewState?.currentQuestion === 8;

  // ── Skip current doc ──
  if (nlu.intent === "skip_doc") {
    const skippedDocs: string[] = ctx.skippedDocs || [];
    const currentDoc = getNextExpectedDoc([...collectedDocs, ...skippedDocs]);
    
    if (!currentDoc) {
      if (interviewDone) {
        return { response: already_complete(), newState: "completed" as ProspectState, contextUpdates: {} };
      }
      return { response: doc_all_complete(firstName), newState: "interview_ready" as ProspectState, contextUpdates: {} };
    }

    const newSkipped = [...skippedDocs, currentDoc.key];
    const nextDoc = getNextExpectedDoc([...collectedDocs, ...newSkipped]);
    const pendingCount = TOTAL_DOCS - collectedDocs.length;

    if (!nextDoc) {
      if (interviewDone) {
        return {
          response: doc_skipped(currentDoc.label, "—", pendingCount) + "\n\nCuando tengas los documentos pendientes, mándamelos.",
          newState: state,
          contextUpdates: { skippedDocs: newSkipped },
        };
      }
      return {
        response: doc_skipped(currentDoc.label, "entrevista", pendingCount) + "\n\nSi quieres, podemos hacer la *entrevista* mientras tanto. Escribe *entrevista* para empezar.",
        newState: state,
        contextUpdates: { skippedDocs: newSkipped },
      };
    }

    return {
      response: doc_skipped(currentDoc.label, nextDoc.label, pendingCount),
      newState: state,
      contextUpdates: { skippedDocs: newSkipped },
    };
  }

  // ── Ask progress / status ──
  if (nlu.intent === "ask_progress") {
    const pendingLabels = getPendingDocLabels(collectedDocs);
    return {
      response: doc_status(firstName, collectedDocs.length, TOTAL_DOCS, pendingLabels, interviewDone),
      newState: state,
      contextUpdates: {},
    };
  }

  // ── Jump directly to interview (skip ALL remaining docs) ──
  if (nlu.intent === "jump_to_interview") {
    if (interviewDone) {
      const pendingLabels = getPendingDocLabels(collectedDocs);
      return {
        response: `Ya completaste la entrevista ✓\n\n` + doc_status(firstName, collectedDocs.length, TOTAL_DOCS, pendingLabels, true),
        newState: state,
        contextUpdates: {},
      };
    }
    // Mark ALL remaining docs as skipped
    const pendingKeys = DOC_ORDER
      .map((d) => d.key)
      .filter((k) => !collectedDocs.includes(k) && !(ctx.skippedDocs || []).includes(k));
    const newSkipped = [...(ctx.skippedDocs || []), ...pendingKeys];
    const pendingCount = TOTAL_DOCS - collectedDocs.length;
    return {
      response: `Entendido, ${firstName}. Vamos a la entrevista ahora — puedes mandarme los *${pendingCount} documento${pendingCount !== 1 ? 's' : ''} pendiente${pendingCount !== 1 ? 's' : ''}* después.\n\n${interview_intro()}`,
      newState: "interview_ready" as ProspectState,
      contextUpdates: { skippedDocs: newSkipped },
    };
  }

  // ── Want to start interview ──
  if (nlu.intent === "want_interview") {
    if (interviewDone) {
      const pendingLabels = getPendingDocLabels(collectedDocs);
      return {
        response: `Ya completaste la entrevista ✓\n\n` + doc_status(firstName, collectedDocs.length, TOTAL_DOCS, pendingLabels, true),
        newState: state,
        contextUpdates: {},
      };
    }
    return {
      response: interview_intro(),
      newState: "interview_ready",
      contextUpdates: {},
    };
  }

  // ── Handle questions ──
  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || body);
    if (answer) {
      const nextDoc = getNextExpectedDoc([...collectedDocs, ...(ctx.skippedDocs || [])]);
      const docPrompt = nextDoc ? `\n\nCuando puedas, mándame tu *${nextDoc.label}* 📷` : "";
      return { response: answer + docPrompt, newState: state, contextUpdates: {} };
    }
  }

  // ── Check doc-specific FAQ ──
  const { DOC_FAQ } = await import('./templates');
  const nextDocForFaq = getNextExpectedDoc([...collectedDocs, ...(ctx.skippedDocs || [])]);
  const currentDocKey = nextDocForFaq?.key || '';
  const docFaq = DOC_FAQ[currentDocKey];
  if (docFaq) {
    const lower = body.toLowerCase();
    for (const [keyword, answer] of Object.entries(docFaq)) {
      if (lower.includes(keyword)) {
        return { response: answer + `\n\nCuando los tengas, mándamelos 📷`, newState: state, contextUpdates: {} };
      }
    }
  }

  // ── Default: remind what doc we're waiting for ──
  const nextDoc = nextDocForFaq;
  if (nextDoc) {
    return {
      response: `Mándame tu *${nextDoc.label}* 📷\n\n_Escribe "siguiente" para saltar, "estado" para ver tu avance, o "entrevista" para hacer las preguntas._`,
      newState: state,
      contextUpdates: {},
    };
  }

  // All docs complete
  if (interviewDone) {
    try { await updateProspectStatus(phone, "expediente_completo"); } catch (e: any) { console.error(e.message); }
    return {
      response: doc_status(firstName, collectedDocs.length, TOTAL_DOCS, [], true),
      newState: "completed" as ProspectState,
      contextUpdates: {},
    };
  }

  return {
    response: doc_all_complete(firstName),
    newState: "interview_ready" as ProspectState,
    contextUpdates: {},
  };
}

// ── INTERVIEW READY → "empezar" ──

async function handleInterviewReady(
  phone: string,
  nlu: NLUResult,
  ctx: AgentContext,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const firstName = getFirstName(ctx);

  if (nlu.intent === "affirm" || nlu.intent === "want_interview") {
    // Initialize interview state
    const interviewState: InterviewState = {
      folioId: ctx.folio || "",
      currentQuestion: 0,
      answers: {},
      transcripts: [],
    };

    const questionText = getCurrentQuestion(interviewState);
    return {
      response: getInterviewWelcome() + "\n\n" + questionText,
      newState: "interview_q1",
      contextUpdates: { interviewState },
    };
  }

  if (nlu.intent === "deny" || nlu.intent === "maybe_later") {
    return {
      response: `Sin problema, ${firstName}. Cuando estés listo para la entrevista, escríbeme "entrevista".`,
      newState: "interview_ready",
      contextUpdates: {},
    };
  }

  // If they send a doc status request
  if (nlu.intent === "ask_progress") {
    const collectedDocs = ctx.docsCollected || [];
    const pendingLabels = getPendingDocLabels(collectedDocs);
    const interviewDone = ctx.interviewState?.currentQuestion === 8;
    return {
      response: doc_status(firstName, collectedDocs.length, TOTAL_DOCS, pendingLabels, interviewDone),
      newState: "interview_ready",
      contextUpdates: {},
    };
  }

  return {
    response: interview_intro(),
    newState: "interview_ready",
    contextUpdates: {},
  };
}

// ── INTERVIEW Q1–Q8: Text Answer ──

async function handleInterviewTextAnswer(
  phone: string,
  body: string,
  state: ProspectState,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const interviewState = ctx.interviewState;
  if (!interviewState) {
    return { response: fallback_state_error(), newState: state, contextUpdates: {} };
  }

  // Handle questions and navigation during interview (don't break flow)
  const nlu = await extractIntent(body, state);

  // ── Go back to previous question ──
  if (nlu.intent === "go_back") {
    let targetQ = nlu.entities.question_number;
    if (targetQ === -1) {
      // Go to previous question (currentQuestion is 0-indexed)
      targetQ = interviewState.currentQuestion - 1;
    } else {
      // Convert from 1-indexed to 0-indexed
      targetQ = targetQ - 1;
    }
    // Validate range: can only go back to questions already answered
    if (targetQ >= 0 && targetQ < interviewState.currentQuestion) {
      const updatedInterviewState: InterviewState = {
        ...interviewState,
        currentQuestion: targetQ,
      };
      const qText = getCurrentQuestion(updatedInterviewState);
      const targetState = `interview_q${targetQ + 1}` as ProspectState;
      return {
        response: `Ok, regresamos a la pregunta ${targetQ + 1}. Tu respuesta anterior se reemplazar\u00e1.\n\n${qText}`,
        newState: targetState,
        contextUpdates: { interviewState: updatedInterviewState },
      };
    }
    // Invalid target — repeat current question
    const q = getCurrentQuestion(interviewState);
    return {
      response: `No puedo regresar a esa pregunta. Estamos en:\n\n${q}`,
      newState: state,
      contextUpdates: {},
    };
  }

  // ── Pause/later ──
  if (nlu.intent === "maybe_later") {
    const firstName = getFirstName(ctx);
    return {
      response: `No hay problema ${firstName}, cuando quieras retomamos. Tu avance queda guardado.\n\nCuando estés listo, solo escríbeme y seguimos donde nos quedamos. 👍`,
      newState: state,
      contextUpdates: {},
    };
  }

  // ── Cancel/quit interview ──
  if (nlu.intent === "deny") {
    const firstName = getFirstName(ctx);
    const collectedDocs = ctx.docsCollected || [];
    const pendingCount = TOTAL_DOCS - collectedDocs.length;
    if (pendingCount > 0) {
      const nextDoc = getNextExpectedDoc(collectedDocs);
      return {
        response: `Ok ${firstName}, dejamos la entrevista por ahora. La puedes retomar despu\u00e9s.\n\nTe faltan *${pendingCount} documentos*. Si quieres seguir con los docs, m\u00e1ndame tu *${nextDoc?.label || 'documento'}* \ud83d\udcf7\n\nEscribe *entrevista* cuando quieras retomar las preguntas.`,
        newState: "docs_pending" as ProspectState,
        contextUpdates: { skippedDocs: [] },
      };
    }
    return {
      response: `Ok ${firstName}, dejamos la entrevista. Escribe *entrevista* cuando quieras retomarla.`,
      newState: "interview_ready" as ProspectState,
      contextUpdates: {},
    };
  }

  // ── Skip question ("siguiente" in interview context) ──
  if (nlu.intent === "skip_doc" || /^\s*(siguie?nte|skip|saltar|paso|siguiente)\s*$/i.test(body.trim())) {
    return processInterviewStep(phone, "no sabe", 0, interviewState, ctx, storage);
  }

  // ── "No sé" / don't know ──
  const lowerBody = body.toLowerCase().trim();
  if (/^(no\s*s[eé]|nos[eé]|ni\s*idea|no\s+tengo\s+idea|quien\s+sabe|pas[ao]|no\s+s[eé]\s+\w+)$/i.test(lowerBody)) {
    const q = getCurrentQuestion(interviewState);
    return {
      response: `No hay problema, un aproximado está bien. No tiene que ser exacto.\n\n${q}\n\n_Si de plano no sabes, escribe *siguiente* para saltar esta pregunta._`,
      newState: state,
      contextUpdates: {},
    };
  }

  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || body);
    if (answer) {
      const q = getCurrentQuestion(interviewState);
      return { response: answer + "\n\n" + q, newState: state, contextUpdates: {} };
    }
  }

  return processInterviewStep(phone, body, 0, interviewState, ctx, storage);
}

// ── INTERVIEW Q1–Q8: Voice Answer ──

async function handleInterviewVoiceAnswer(
  phone: string,
  transcript: string,
  audioDurationMs: number,
  state: ProspectState,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const interviewState = ctx.interviewState;
  if (!interviewState) {
    return { response: fallback_state_error(), newState: state, contextUpdates: {} };
  }

  return processInterviewStep(phone, transcript, audioDurationMs, interviewState, ctx, storage);
}

// ── INTERVIEW: Process Step ──

async function processInterviewStep(
  phone: string,
  transcript: string,
  audioDurationMs: number,
  interviewState: InterviewState,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const firstName = getFirstName(ctx);

  try {
    const result = await processInterviewAnswer(
      interviewState,
      transcript,
      audioDurationMs,
      llmCall,
    );

    if (result.isComplete) {
      // Save evaluation to DB
      if (result.evaluation) {
        try {
          const sql = getSQL();
          await sql`
            INSERT INTO evaluaciones_taxi (folio, phone, datos, coherencia, created_at)
            VALUES (${ctx.folio || ''}, ${phone}, ${JSON.stringify(result.evaluation.datos)}, ${JSON.stringify(result.evaluation.coherencia)}, NOW())
          `;
          console.log(`[Orchestrator] Evaluation saved for ${phone}: coherencia=${JSON.stringify(result.evaluation.coherencia).slice(0, 60)}`);
        } catch (error: any) {
          console.error(`[Orchestrator] Save evaluation failed:`, error.message);
        }

        // Flush interview answers + coherencia → originations.interview_data
        flushInterviewToOrigination(
          phone,
          result.evaluation.datos || {},
          result.evaluation.coherencia || {},
        ).catch(() => {});
      }

      // Notify team with evaluation summary
      const evalSummary = result.evaluation?.coherencia
        ? `\nCoherencia: ${JSON.stringify(result.evaluation.coherencia).slice(0, 100)}`
        : '';
      try {
        await notifyTeam(`*Entrevista completada* \u2705\nNombre: ${ctx.nombre || '?'}\nFolio: ${ctx.folio || '?'}\nTel: ${phone}${evalSummary}`);
      } catch (error: any) {
        console.error(`[Orchestrator] notifyTeam failed:`, error.message);
      }

      try {
        await updateProspectStatus(phone, "evaluado");
      } catch (error: any) {
        console.error(`[Orchestrator] updateProspectStatus failed:`, error.message);
      }

      // Check pending docs
      const collectedDocs = ctx.docsCollected || [];
      const pendingCount = TOTAL_DOCS - collectedDocs.length;
      const hasPendingDocs = pendingCount > 0;

      if (!hasPendingDocs) {
        // All complete!
        try { await updateProspectStatus(phone, "expediente_completo"); } catch (e: any) { console.error(e.message); }
        return {
          response: interview_complete(firstName, false),
          newState: "completed" as ProspectState,
          contextUpdates: { interviewState: result.newState },
        };
      }

      return {
        response: interview_complete(firstName, true, pendingCount),
        newState: "interview_complete" as ProspectState,
        contextUpdates: { interviewState: result.newState },
      };
    }

    // Advance to next question
    const nextQNum = result.newState.currentQuestion + 1; // 1-indexed for state name
    const nextState = `interview_q${nextQNum}` as ProspectState;

    // Build response: confirmation note + next question
    let responseText = result.reply;

    return {
      response: responseText,
      newState: nextState,
      contextUpdates: { interviewState: result.newState },
    };
  } catch (error: any) {
    console.error(`[Orchestrator] processInterviewAnswer failed:`, error.message);
    return {
      response: "No pude procesar tu respuesta. ¿Puedes intentar de nuevo?",
      newState: `interview_q${interviewState.currentQuestion + 1}` as ProspectState,
      contextUpdates: {},
    };
  }
}

// ── INTERVIEW_COMPLETE → check pending docs, allow sending more docs ──

async function handleInterviewCompleteText(
  phone: string,
  body: string,
  nlu: NLUResult,
  ctx: AgentContext,
  state: ProspectState,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const firstName = getFirstName(ctx);
  const collectedDocs = ctx.docsCollected || [];
  const pendingCount = TOTAL_DOCS - collectedDocs.length;

  // If all docs are done → all_complete
  if (pendingCount === 0) {
    try { await updateProspectStatus(phone, "expediente_completo"); } catch (e: any) { console.error(e.message); }
    return {
      response: already_complete(),
      newState: "completed" as ProspectState,
      contextUpdates: {},
    };
  }

  // ── Ask progress / status ──
  if (nlu.intent === "ask_progress") {
    const pendingLabels = getPendingDocLabels(collectedDocs);
    return {
      response: doc_status(firstName, collectedDocs.length, TOTAL_DOCS, pendingLabels, true),
      newState: state,
      contextUpdates: {},
    };
  }

  // ── Skip doc ──
  if (nlu.intent === "skip_doc") {
    // Delegate to docs handler
    return handleDocsText(phone, body, nlu, ctx, "docs_pending" as ProspectState, storage);
  }

  // ── Handle questions ──
  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || body);
    if (answer) {
      return { response: answer, newState: state, contextUpdates: {} };
    }
  }

  // ── Default: remind about pending docs ──
  const nextDoc = getNextExpectedDoc([...collectedDocs, ...(ctx.skippedDocs || [])]);
  if (nextDoc) {
    return {
      response: `${firstName}, te faltan *${pendingCount} documentos*. Mándame tu *${nextDoc.label}* 📷\n\nEscribe *estado* para ver cuáles faltan.`,
      newState: state,
      contextUpdates: {},
    };
  }

  // ALL remaining docs were skipped — re-present them
  if (pendingCount > 0) {
    const firstPending = getNextExpectedDoc(collectedDocs); // without skipped
    if (firstPending) {
      return {
        response: `${firstName}, te faltan *${pendingCount} documentos* por capturar. Los que saltaste los puedes mandar ahora.\n\nMándame tu *${firstPending.label}* 📷\n\n_Escribe *estado* para ver cuáles faltan._`,
        newState: "docs_pending" as ProspectState,
        contextUpdates: { skippedDocs: [] },
      };
    }
  }

  return {
    response: already_complete(),
    newState: "completed" as ProspectState,
    contextUpdates: {},
  };
}

// ── COMPLETED → allow re-entering doc capture if docs still pending ──

async function handleCompletedText(
  phone: string, body: string, nlu: NLUResult, ctx: AgentContext, storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {
  const firstName = getFirstName(ctx);
  const collectedDocs = ctx.docsCollected || [];
  const pendingCount = TOTAL_DOCS - collectedDocs.length;

  // If truly complete (all 14 captured), stay completed
  if (pendingCount === 0) {
    return { response: already_complete(), newState: "completed" as ProspectState, contextUpdates: {} };
  }

  // User wants to check status — re-enter doc capture
  if (nlu.intent === "ask_progress") {
    const pendingLabels = getPendingDocLabels(collectedDocs);
    const interviewDone = ctx.interviewState?.currentQuestion === 8;
    return {
      response: doc_status(firstName, collectedDocs.length, TOTAL_DOCS, pendingLabels, interviewDone),
      newState: "docs_pending" as ProspectState,
      contextUpdates: { skippedDocs: [] },
    };
  }

  // Any other message — tell them they have pending docs and re-enter
  const firstPending = getNextExpectedDoc(collectedDocs); // without skipped
  if (firstPending) {
    return {
      response: `${firstName}, te faltan *${pendingCount} documentos*. Mándame tu *${firstPending.label}* 📷\n\nEscribe *estado* para ver cuáles faltan.`,
      newState: "docs_pending" as ProspectState,
      contextUpdates: { skippedDocs: [] },
    };
  }

  return { response: already_complete(), newState: "completed" as ProspectState, contextUpdates: {} };
}
