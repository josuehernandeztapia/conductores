/**
 * CMU WhatsApp Agent v3 — Orchestrator (State Machine)
 *
 * The core module. A deterministic state machine that:
 * - Controls ALL conversation flow
 * - NEVER generates responses from LLM (always uses templates)
 * - Uses NLU only to understand intent
 * - Uses Vision only to classify documents
 * - Uses RAG only to answer off-flow questions
 *
 * States flow:
 * idle → prospect_fuel_type → prospect_consumo → prospect_show_models →
 * prospect_select_model → prospect_tank (GNV only) → prospect_corrida →
 * prospect_name → docs_capture → interview_ready → interview_q1..q8 →
 * interview_complete
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
import { templates } from "./templates";
import { classifyAndValidateDoc, DOC_ORDER, DOC_LABELS, getNextExpectedDoc, getPendingDocLabels } from "./vision";
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
import { chatCompletion, whisperTranscribe } from "./openai-helper";
import { createFolioFromWhatsApp } from "../folio-manager";
import { DIRECTOR, getPromotor } from "../team-config";

// ─── Constants ───────────────────────────────────────────────────────────────

const SOBREPRECIO_GNV = 11;    // $11/LEQ
const BASE_LEQ = 400;          // base 400 LEQ/mes
const KIT_NUEVO_COST = 9400;   // +$9,400 for new GNV kit
const TOTAL_DOCS = DOC_ORDER.length; // 14

// Gasolina to LEQ conversion: rough estimate
// $22/L gasolina, 10km/L. GNV: $11/LEQ, ~3.5km/LEQ equivalent
// Simplified: pesosMes / 22 * 10 / 3.5 ≈ pesosMes * 1.3 / 11
function pesosToLeq(pesosMes: number): number {
  return Math.round(pesosMes / 11);
}

// ─── Audio Processing ────────────────────────────────────────────────────────

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
      INSERT INTO documents (origination_id, doc_type, doc_label, extracted_data, image_url, cross_check_flags, created_at)
      VALUES (${originationId}, ${docKey}, ${docLabel}, ${JSON.stringify(extractedData)}, ${imageUrl}, ${JSON.stringify(crossCheckFlags)}, NOW())
      ON CONFLICT (origination_id, doc_type)
      DO UPDATE SET extracted_data = ${JSON.stringify(extractedData)}, image_url = ${imageUrl},
                    cross_check_flags = ${JSON.stringify(crossCheckFlags)}, updated_at = NOW()
    `;
  } catch (error: any) {
    console.error(`[Orchestrator] saveDocument failed for ${docKey}:`, error.message);
  }
}

// ─── Build Model Summaries ───────────────────────────────────────────────────

async function buildModelSummaries(leq: number): Promise<{
  summaries: import("./types").ModelSummary[];
  text: string;
}> {
  const recaudo = leq * SOBREPRECIO_GNV;
  const summaries: import("./types").ModelSummary[] = [];

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
        mesGnvLabel: mesGnvCubre ? `Mes ${mesGnvCubre}` : "Mes 34+",
      });
    } catch (error: any) {
      console.error(`[Orchestrator] buildModelSummaries failed for ${m.modelo}:`, error.message);
    }
  }

  const text = await generarResumen5Modelos(leq);
  return { summaries, text };
}

// ─── State Machine Entry Point ───────────────────────────────────────────────

/**
 * Main entry point for the agent v3.
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
    response = templates.fallback_state_error();
  }

  // ── Persist state ──
  const updatedContext: AgentContext = { ...ctx, ...contextUpdates };
  try {
    await updateSession(phone, {
      state: "simulation" as any, // reusing existing state type; agentState tracks v3 state
      context: {
        ...session.context,
        agentState: newState,
        agentContext: updatedContext,
      } as any,
    });
  } catch (error: any) {
    console.error(`[Orchestrator] State persist failed for ${phone}:`, error.message);
  }

  console.log(`[Orchestrator] ${phone} | ${currentState} → ${newState} | response="${response.slice(0, 60)}..."`);
  return response;
}

// ─── Text Message Handler ────────────────────────────────────────────────────

async function handleTextMessage(
  phone: string,
  body: string,
  state: ProspectState,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  // ── NLU ──
  const nlu = await extractIntent(body, state);
  console.log(`[Orchestrator] NLU: intent=${nlu.intent} confidence=${nlu.confidence} entities=${JSON.stringify(nlu.entities)}`);

  // ── Check for off-flow questions (any state) ──
  if (nlu.intent === "ask_question" && state !== "idle") {
    const answer = await answerQuestion(nlu.entities.question || body);
    if (answer) {
      return { response: answer, newState: state, contextUpdates: {} };
    }
    // If RAG has no answer, fall through to state handler
  }

  // ── State dispatch ──
  switch (state) {
    case "idle":
      return handleIdle(phone, body, nlu, ctx, storage);

    case "prospect_fuel_type":
      return handleFuelType(phone, nlu, ctx);

    case "prospect_consumo":
      return handleConsumo(phone, nlu, ctx);

    case "prospect_show_models":
    case "prospect_select_model":
      return handleModelSelection(phone, body, nlu, ctx);

    case "prospect_tank":
      return handleTankDecision(phone, nlu, ctx);

    case "prospect_corrida":
      return handleCorridaResponse(phone, nlu, ctx, storage);

    case "prospect_name":
      return handleNameCapture(phone, body, nlu, ctx, storage);

    case "docs_capture":
      return handleDocsText(phone, body, nlu, ctx, storage);

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
      return {
        response: templates.interview_already_done(),
        newState: "interview_complete",
        contextUpdates: {},
      };

    default:
      return handleIdle(phone, body, nlu, ctx, storage);
  }
}

// ─── Audio Message Handler ───────────────────────────────────────────────────

async function handleAudioMessage(
  phone: string,
  mediaUrl: string,
  state: ProspectState,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  // Download and transcribe
  let transcript: string;
  try {
    const audioBuffer = await downloadTwilioMedia(mediaUrl);
    transcript = await transcribeAudio(audioBuffer);
    console.log(`[Orchestrator] Whisper transcript: "${transcript.slice(0, 100)}"`);
  } catch (error: any) {
    console.error(`[Orchestrator] Audio processing failed:`, error.message);
    return { response: templates.audio_error(), newState: state, contextUpdates: {} };
  }

  if (!transcript || transcript.trim().length === 0) {
    return { response: templates.audio_error(), newState: state, contextUpdates: {} };
  }

  // If in interview state → process as interview answer
  if (state.startsWith("interview_q")) {
    return handleInterviewVoiceAnswer(phone, transcript, state, ctx, storage);
  }

  // Otherwise, treat transcript as text
  return handleTextMessage(phone, transcript, state, ctx, storage);
}

// ─── Image Message Handler ───────────────────────────────────────────────────

async function handleImageMessage(
  phone: string,
  mediaUrl: string,
  mediaType: string,
  state: ProspectState,
  ctx: AgentContext,
  body: string,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  // Only process images during docs_capture state
  if (state !== "docs_capture") {
    // If they're sending an image before the docs stage, acknowledge and continue flow
    if (state === "idle" || state === "prospect_fuel_type") {
      return handleTextMessage(phone, body || "", state, ctx, storage);
    }
    return {
      response: "Recibí tu imagen, pero ahorita no estamos en la etapa de documentos. " +
        (body ? "" : templates.fallback_no_understand()),
      newState: state,
      contextUpdates: {},
    };
  }

  // Download image from Twilio
  let imageBuffer: Buffer;
  try {
    imageBuffer = await downloadTwilioMedia(mediaUrl);
  } catch (error: any) {
    console.error(`[Orchestrator] Image download failed:`, error.message);
    return { response: templates.fallback_state_error(), newState: state, contextUpdates: {} };
  }

  const imageBase64 = imageBuffer.toString("base64");

  // Determine expected document
  const collectedDocs = ctx.docsCollected || [];
  const nextDoc = getNextExpectedDoc(collectedDocs);

  if (!nextDoc) {
    // All docs already collected
    return {
      response: templates.doc_all_complete(collectedDocs.length),
      newState: "interview_ready",
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
      response: templates.doc_illegible(nextDoc.label),
      newState: state,
      contextUpdates: {},
    };
  }

  // ── Unknown type ──
  if (visionResult.detected_type === "unknown") {
    return {
      response: templates.doc_invalid(nextDoc.label, visionResult.rejection_reason || "No reconozco este documento."),
      newState: state,
      contextUpdates: {},
    };
  }

  // ── Detected a valid doc type ──
  const detectedKey = visionResult.detected_type;
  const detectedLabel = DOC_LABELS[detectedKey] || detectedKey;

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

  // Save document to DB
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

  // Update pipeline docs count
  try {
    await updateProspectDocs(phone, newCollected.length, TOTAL_DOCS);
  } catch (error: any) {
    console.error(`[Orchestrator] updateProspectDocs failed:`, error.message);
  }

  // ── Cross-check warnings ──
  if (visionResult.cross_check_flags.length > 0) {
    const warningResponse = templates.doc_cross_check_warning(detectedLabel, visionResult.cross_check_flags);
    // Still save and advance — just warn
    const nextDocAfter = getNextExpectedDoc(newCollected);
    const contextUp: Partial<AgentContext> = {
      docsCollected: newCollected,
      existingData: newExistingData,
      currentDocIndex: (ctx.currentDocIndex || 0) + 1,
    };

    if (!nextDocAfter) {
      // All docs complete
      try { await notifyTeam(templates.notify_docs_complete(ctx.folio || "?", ctx.nombre || "?")); } catch (e: any) { console.error("[Orchestrator] notifyTeam failed:", e.message); }
      return {
        response: warningResponse + "\n\n" + templates.doc_all_complete(newCollected.length),
        newState: "interview_ready",
        contextUpdates: contextUp,
      };
    }

    return {
      response: warningResponse + "\n\n" + templates.doc_received(detectedLabel, newCollected.length, TOTAL_DOCS, nextDocAfter.label),
      newState: state,
      contextUpdates: contextUp,
    };
  }

  // ── Wrong type but valid doc ──
  if (!visionResult.matches_expected && detectedKey !== nextDoc.key) {
    const nextDocAfter = getNextExpectedDoc(newCollected);
    const contextUp: Partial<AgentContext> = {
      docsCollected: newCollected,
      existingData: newExistingData,
      currentDocIndex: (ctx.currentDocIndex || 0) + 1,
    };

    if (!nextDocAfter) {
      try { await notifyTeam(templates.notify_docs_complete(ctx.folio || "?", ctx.nombre || "?")); } catch (e: any) { console.error("[Orchestrator] notifyTeam failed:", e.message); }
      return {
        response: `Recibí *${detectedLabel}* (esperaba ${nextDoc.label}, pero está bien).\n\n${templates.doc_all_complete(newCollected.length)}`,
        newState: "interview_ready",
        contextUpdates: contextUp,
      };
    }

    return {
      response: `Recibí *${detectedLabel}* (esperaba ${nextDoc.label}, pero está bien). ${newCollected.length}/${TOTAL_DOCS}\n\nAhora mándame tu *${nextDocAfter.label}*`,
      newState: state,
      contextUpdates: contextUp,
    };
  }

  // ── Correct doc, accepted ──
  const contextUp: Partial<AgentContext> = {
    docsCollected: newCollected,
    existingData: newExistingData,
    currentDocIndex: (ctx.currentDocIndex || 0) + 1,
  };

  const nextDocAfter = getNextExpectedDoc(newCollected);
  if (!nextDocAfter) {
    // All docs complete!
    try { await notifyTeam(templates.notify_docs_complete(ctx.folio || "?", ctx.nombre || "?")); } catch (e: any) { console.error("[Orchestrator] notifyTeam failed:", e.message); }
    return {
      response: templates.doc_received_last(detectedLabel, newCollected.length, TOTAL_DOCS),
      newState: "interview_ready",
      contextUpdates: contextUp,
    };
  }

  return {
    response: templates.doc_received(detectedLabel, newCollected.length, TOTAL_DOCS, nextDocAfter.label),
    newState: "docs_capture",
    contextUpdates: contextUp,
  };
}

// ─── State Handlers ──────────────────────────────────────────────────────────

// ── IDLE ──

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

  // If they already mention fuel type, skip to consumo
  if (nlu.intent === "fuel_gnv") {
    return {
      response: templates.ask_consumo_gnv(),
      newState: "prospect_consumo",
      contextUpdates: { fuelType: "gnv", canal },
    };
  }
  if (nlu.intent === "fuel_gasolina") {
    return {
      response: templates.ask_consumo_gasolina(),
      newState: "prospect_consumo",
      contextUpdates: { fuelType: "gasolina", canal },
    };
  }

  // If they ask a question
  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || body);
    const intro = templates.greeting_prospect(ctx.profileName || "");
    if (answer) {
      return {
        response: `${answer}\n\n${intro}`,
        newState: "prospect_fuel_type",
        contextUpdates: { canal },
      };
    }
  }

  // Default: greeting → ask fuel type
  return {
    response: templates.greeting_prospect(ctx.profileName || ""),
    newState: "prospect_fuel_type",
    contextUpdates: { canal },
  };
}

// ── FUEL TYPE ──

async function handleFuelType(
  phone: string,
  nlu: NLUResult,
  ctx: AgentContext,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  if (nlu.intent === "fuel_gnv") {
    try {
      await upsertProspect({ phone, fuel_type: "gnv", status: "interesado" });
    } catch (error: any) {
      console.error(`[Orchestrator] upsertProspect failed:`, error.message);
    }
    return {
      response: templates.ask_consumo_gnv(),
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
      response: templates.ask_consumo_gasolina(),
      newState: "prospect_consumo",
      contextUpdates: { fuelType: "gasolina" },
    };
  }

  // Handle questions
  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || "");
    if (answer) {
      return { response: answer + "\n\n" + templates.ask_fuel_type(), newState: "prospect_fuel_type", contextUpdates: {} };
    }
  }

  if (nlu.intent === "deny" || nlu.intent === "maybe_later") {
    return { response: templates.cold_goodbye(), newState: "idle", contextUpdates: {} };
  }

  return {
    response: templates.ask_fuel_type(),
    newState: "prospect_fuel_type",
    contextUpdates: {},
  };
}

// ── CONSUMO ──

async function handleConsumo(
  phone: string,
  nlu: NLUResult,
  ctx: AgentContext,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  let leq: number | null = null;
  let gastoPesos: number | null = null;

  if (nlu.intent === "consumo_number" && nlu.entities.leq) {
    leq = nlu.entities.leq;
    if (leq < 50 || leq > 3000) {
      return { response: templates.consumo_out_of_range(), newState: "prospect_consumo", contextUpdates: {} };
    }
  } else if (nlu.intent === "gasto_number" && nlu.entities.pesos) {
    gastoPesos = nlu.entities.pesos;
    if (gastoPesos < 500 || gastoPesos > 30000) {
      return { response: templates.gasto_out_of_range(), newState: "prospect_consumo", contextUpdates: {} };
    }
    leq = pesosToLeq(gastoPesos);
  }

  if (leq) {
    // Update prospect
    try {
      await upsertProspect({ phone, consumo_mensual: leq });
    } catch (error: any) {
      console.error(`[Orchestrator] upsertProspect failed:`, error.message);
    }

    // Build model summaries
    const { summaries } = await buildModelSummaries(leq);
    const recaudo = leq * SOBREPRECIO_GNV;

    if (summaries.length === 0) {
      return {
        response: templates.no_models_available(),
        newState: "prospect_consumo",
        contextUpdates: { consumoLeq: leq, gastoPesosMes: gastoPesos || undefined },
      };
    }

    const response = ctx.fuelType === "gasolina" && gastoPesos
      ? templates.show_models_gasolina(gastoPesos, summaries)
      : templates.show_models(leq, recaudo, summaries);

    return {
      response,
      newState: "prospect_select_model",
      contextUpdates: { consumoLeq: leq, gastoPesosMes: gastoPesos || undefined },
    };
  }

  // Handle questions
  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || "");
    if (answer) {
      const askAgain = ctx.fuelType === "gasolina" ? templates.ask_consumo_gasolina() : templates.ask_consumo_gnv();
      return { response: answer + "\n\n" + askAgain, newState: "prospect_consumo", contextUpdates: {} };
    }
  }

  if (nlu.intent === "deny" || nlu.intent === "maybe_later") {
    return { response: templates.cold_maybe_later(), newState: "idle", contextUpdates: {} };
  }

  // Can't parse → ask again
  const askAgain = ctx.fuelType === "gasolina" ? templates.ask_consumo_gasolina() : templates.ask_consumo_gnv();
  return { response: templates.fallback_no_understand() + "\n\n" + askAgain, newState: "prospect_consumo", contextUpdates: {} };
}

// ── MODEL SELECTION ──

async function handleModelSelection(
  phone: string,
  body: string,
  nlu: NLUResult,
  ctx: AgentContext,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  // Select a specific model
  if (nlu.intent === "select_model" && nlu.entities.modelo) {
    const matched = matchModelFromText(nlu.entities.modelo);
    if (!matched) {
      return { response: templates.model_not_found(), newState: "prospect_select_model", contextUpdates: {} };
    }

    const pv = await getPvForModel(matched.marca, matched.modelo, matched.anio);
    const modelName = `${matched.marca} ${matched.modelo} ${matched.anio}`;

    // Perfil A (GNV): ask about tank
    if (ctx.fuelType === "gnv") {
      return {
        response: templates.ask_tank(modelName, pv),
        newState: "prospect_tank",
        contextUpdates: { selectedModel: matched, pvBase: pv },
      };
    }

    // Perfil B (gasolina): always new kit → go straight to corrida
    const pvWithKit = pv + KIT_NUEVO_COST;
    const leq = ctx.consumoLeq || BASE_LEQ;
    const corrida = generarCorridaEstimada(matched.modelo, matched.anio, pvWithKit, leq);

    return {
      response: templates.show_corrida(corrida.resumenWhatsApp),
      newState: "prospect_corrida",
      contextUpdates: {
        selectedModel: matched,
        pvBase: pvWithKit,
        reuseTank: false,
        corridaResumen: corrida.resumenWhatsApp,
      },
    };
  }

  // Want to see all models again
  if (nlu.intent === "see_all_models") {
    const leq = ctx.consumoLeq || BASE_LEQ;
    const { summaries } = await buildModelSummaries(leq);
    const recaudo = leq * SOBREPRECIO_GNV;

    if (summaries.length === 0) {
      return { response: templates.no_models_available(), newState: "prospect_select_model", contextUpdates: {} };
    }

    return {
      response: templates.show_models(leq, recaudo, summaries),
      newState: "prospect_select_model",
      contextUpdates: {},
    };
  }

  // Try matching model name directly from body text
  const matched = matchModelFromText(body);
  if (matched) {
    const pv = await getPvForModel(matched.marca, matched.modelo, matched.anio);
    const modelName = `${matched.marca} ${matched.modelo} ${matched.anio}`;

    if (ctx.fuelType === "gnv") {
      return {
        response: templates.ask_tank(modelName, pv),
        newState: "prospect_tank",
        contextUpdates: { selectedModel: matched, pvBase: pv },
      };
    }

    const pvWithKit = pv + KIT_NUEVO_COST;
    const leq = ctx.consumoLeq || BASE_LEQ;
    const corrida = generarCorridaEstimada(matched.modelo, matched.anio, pvWithKit, leq);

    return {
      response: templates.show_corrida(corrida.resumenWhatsApp),
      newState: "prospect_corrida",
      contextUpdates: {
        selectedModel: matched,
        pvBase: pvWithKit,
        reuseTank: false,
        corridaResumen: corrida.resumenWhatsApp,
      },
    };
  }

  // Handle questions
  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || body);
    if (answer) {
      return { response: answer + "\n\n¿Cuál modelo te interesa?", newState: "prospect_select_model", contextUpdates: {} };
    }
  }

  if (nlu.intent === "deny" || nlu.intent === "maybe_later") {
    return { response: templates.cold_maybe_later(), newState: "idle", contextUpdates: {} };
  }

  return { response: templates.model_not_found(), newState: "prospect_select_model", contextUpdates: {} };
}

// ── TANK DECISION (GNV only) ──

async function handleTankDecision(
  phone: string,
  nlu: NLUResult,
  ctx: AgentContext,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  if (!ctx.selectedModel || !ctx.pvBase) {
    return { response: templates.fallback_state_error(), newState: "prospect_select_model", contextUpdates: {} };
  }

  let reuse: boolean | null = null;

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

    return {
      response: templates.show_corrida(corrida.resumenWhatsApp),
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
        response: answer + "\n\n" + templates.ask_tank(
          `${ctx.selectedModel.marca} ${ctx.selectedModel.modelo} ${ctx.selectedModel.anio}`,
          ctx.pvBase,
        ),
        newState: "prospect_tank",
        contextUpdates: {},
      };
    }
  }

  return {
    response: templates.ask_tank(
      `${ctx.selectedModel.marca} ${ctx.selectedModel.modelo} ${ctx.selectedModel.anio}`,
      ctx.pvBase,
    ),
    newState: "prospect_tank",
    contextUpdates: {},
  };
}

// ── CORRIDA RESPONSE ──

async function handleCorridaResponse(
  phone: string,
  nlu: NLUResult,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  if (nlu.intent === "affirm" || nlu.intent === "want_register") {
    return {
      response: templates.ask_name(),
      newState: "prospect_name",
      contextUpdates: {},
    };
  }

  if (nlu.intent === "deny") {
    return { response: templates.cold_goodbye(), newState: "idle", contextUpdates: {} };
  }

  if (nlu.intent === "maybe_later") {
    return { response: templates.cold_maybe_later(), newState: "idle", contextUpdates: {} };
  }

  // If they give their name directly
  if (nlu.intent === "give_name" && nlu.entities.nombre) {
    return createFolioAndAdvance(phone, nlu.entities.nombre, ctx, storage);
  }

  // Handle questions
  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || "");
    if (answer) {
      return {
        response: answer + "\n\n¿Quieres empezar el proceso? Solo necesito tu nombre.",
        newState: "prospect_corrida",
        contextUpdates: {},
      };
    }
  }

  return {
    response: templates.confirm_interest(),
    newState: "prospect_corrida",
    contextUpdates: {},
  };
}

// ── NAME CAPTURE ──

async function handleNameCapture(
  phone: string,
  body: string,
  nlu: NLUResult,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  // Check for name intent
  if (nlu.intent === "give_name" && nlu.entities.nombre) {
    return createFolioAndAdvance(phone, nlu.entities.nombre, ctx, storage);
  }

  // If body looks like a name (2+ words, no special characters)
  const cleanBody = body.trim();
  const words = cleanBody.split(/\s+/);
  if (words.length >= 2 && /^[A-ZÁÉÍÓÚÑa-záéíóúñ\s]+$/.test(cleanBody)) {
    return createFolioAndAdvance(phone, cleanBody, ctx, storage);
  }

  if (nlu.intent === "deny" || nlu.intent === "maybe_later") {
    return { response: templates.cold_maybe_later(), newState: "idle", contextUpdates: {} };
  }

  return {
    response: templates.name_too_short(),
    newState: "prospect_name",
    contextUpdates: {},
  };
}

// ── Create Folio and Advance to Docs ──

async function createFolioAndAdvance(
  phone: string,
  nombre: string,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {
  try {
    const { folio, originationId, taxistaId } = await createFolioFromWhatsApp(
      storage,
      phone,      // senderPhone (self-service)
      nombre,     // taxistaName
      phone,      // taxistaPhone
      "CONCESIONARIO",
    );

    // Update prospect pipeline
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

    // Notify team
    try {
      await notifyTeam(templates.notify_folio_created(folio, nombre, phone));
    } catch (error: any) {
      console.error(`[Orchestrator] notifyTeam failed:`, error.message);
    }

    return {
      response: templates.folio_created(nombre, folio),
      newState: "docs_capture",
      contextUpdates: {
        nombre,
        folio,
        originationId,
        taxistaId,
        docsCollected: [],
        currentDocIndex: 0,
        existingData: {},
      },
    };
  } catch (error: any) {
    console.error(`[Orchestrator] createFolioFromWhatsApp failed:`, error.message);
    return {
      response: templates.folio_error(),
      newState: "prospect_name",
      contextUpdates: {},
    };
  }
}

// ── DOCS TEXT HANDLER (skip, progress, interview intent) ──

async function handleDocsText(
  phone: string,
  body: string,
  nlu: NLUResult,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const collectedDocs = ctx.docsCollected || [];

  // Skip current doc
  if (nlu.intent === "skip_doc") {
    return {
      response: templates.doc_skip_offer_interview(),
      newState: "docs_capture",
      contextUpdates: {},
    };
  }

  // Ask progress
  if (nlu.intent === "ask_progress") {
    const pendingLabels = getPendingDocLabels(collectedDocs);
    return {
      response: templates.doc_progress(collectedDocs.length, TOTAL_DOCS, pendingLabels),
      newState: "docs_capture",
      contextUpdates: {},
    };
  }

  // Want to start interview
  if (nlu.intent === "want_interview" || nlu.intent === "affirm") {
    // If they say "empezar" or "si" → start interview
    if (collectedDocs.length > 0 || nlu.intent === "want_interview") {
      return {
        response: templates.interview_ready_prompt(),
        newState: "interview_ready",
        contextUpdates: {},
      };
    }
  }

  // Handle questions
  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || body);
    if (answer) {
      const nextDoc = getNextExpectedDoc(collectedDocs);
      const docPrompt = nextDoc ? `\n\nCuando puedas, mándame tu *${nextDoc.label}* 📷` : "";
      return { response: answer + docPrompt, newState: "docs_capture", contextUpdates: {} };
    }
  }

  // Default: remind what doc we're waiting for
  const nextDoc = getNextExpectedDoc(collectedDocs);
  if (nextDoc) {
    return {
      response: templates.doc_ask_image(nextDoc.label),
      newState: "docs_capture",
      contextUpdates: {},
    };
  }

  // All docs complete
  return {
    response: templates.doc_all_complete(collectedDocs.length),
    newState: "interview_ready",
    contextUpdates: {},
  };
}

// ── INTERVIEW READY ──

async function handleInterviewReady(
  phone: string,
  nlu: NLUResult,
  ctx: AgentContext,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  if (nlu.intent === "affirm" || nlu.intent === "want_interview") {
    // Initialize interview state
    const interviewState: InterviewState = {
      folioId: ctx.folio || "",
      currentQuestion: 0,
      answers: {},
      transcripts: [],
    };

    const q1 = getCurrentQuestion(interviewState);
    return {
      response: templates.interview_start(q1),
      newState: "interview_q1",
      contextUpdates: { interviewState },
    };
  }

  if (nlu.intent === "deny" || nlu.intent === "maybe_later") {
    return {
      response: templates.cold_maybe_later(),
      newState: "interview_ready",
      contextUpdates: {},
    };
  }

  return {
    response: templates.interview_ready_prompt(),
    newState: "interview_ready",
    contextUpdates: {},
  };
}

// ── INTERVIEW: Voice Answer ──

async function handleInterviewVoiceAnswer(
  phone: string,
  transcript: string,
  state: ProspectState,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const interviewState = ctx.interviewState;
  if (!interviewState) {
    return { response: templates.fallback_state_error(), newState: state, contextUpdates: {} };
  }

  return processInterviewStep(phone, transcript, interviewState, ctx, storage);
}

// ── INTERVIEW: Text Answer ──

async function handleInterviewTextAnswer(
  phone: string,
  body: string,
  state: ProspectState,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  const interviewState = ctx.interviewState;
  if (!interviewState) {
    return { response: templates.fallback_state_error(), newState: state, contextUpdates: {} };
  }

  // Handle questions during interview (don't break flow)
  const nlu = await extractIntent(body, state);
  if (nlu.intent === "ask_question") {
    const answer = await answerQuestion(nlu.entities.question || body);
    if (answer) {
      const q = getCurrentQuestion(interviewState);
      return { response: answer + "\n\n" + q, newState: state, contextUpdates: {} };
    }
  }

  return processInterviewStep(phone, body, interviewState, ctx, storage);
}

// ── INTERVIEW: Process Step ──

async function processInterviewStep(
  phone: string,
  transcript: string,
  interviewState: InterviewState,
  ctx: AgentContext,
  storage: any,
): Promise<{ response: string; newState: ProspectState; contextUpdates: Partial<AgentContext> }> {

  try {
    const result = await processInterviewAnswer(
      interviewState,
      transcript,
      0, // audio duration (0 for text)
      llmCall,
    );

    if (result.isComplete) {
      // Interview complete → notify team
      try {
        await notifyTeam(templates.notify_interview_complete(ctx.folio || "?", ctx.nombre || "?"));
      } catch (error: any) {
        console.error(`[Orchestrator] notifyTeam failed:`, error.message);
      }

      try {
        await updateProspectStatus(phone, "evaluado");
      } catch (error: any) {
        console.error(`[Orchestrator] updateProspectStatus failed:`, error.message);
      }

      return {
        response: templates.interview_complete(),
        newState: "interview_complete",
        contextUpdates: { interviewState: result.newState },
      };
    }

    // Advance to next question
    const nextQNum = result.newState.currentQuestion + 1; // 1-indexed for state name
    const nextState = `interview_q${nextQNum}` as ProspectState;

    return {
      response: result.reply,
      newState: nextState,
      contextUpdates: { interviewState: result.newState },
    };
  } catch (error: any) {
    console.error(`[Orchestrator] processInterviewAnswer failed:`, error.message);
    return {
      response: templates.audio_error(),
      newState: `interview_q${interviewState.currentQuestion + 1}` as ProspectState,
      contextUpdates: {},
    };
  }
}
