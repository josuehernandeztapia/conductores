/**
 * CMU WhatsApp Agent v3 — Shared Types
 *
 * Central type definitions used across all agent modules.
 * The orchestrator is a deterministic state machine; the LLM is only a tool.
 */

// ─── Intent Enum ─────────────────────────────────────────────────────────────

export type Intent =
  // Fuel type
  | "fuel_gnv"
  | "fuel_gasolina"
  // Consumo
  | "consumo_number"   // entities: { leq: number }
  | "gasto_number"     // entities: { pesos: number }
  // Model selection
  | "select_model"     // entities: { modelo: string }
  | "see_all_models"
  // Tank (GNV reuse vs new)
  | "reuse_tank"
  | "new_tank"
  // Affirm / Deny
  | "affirm"
  | "deny"
  | "maybe_later"
  // Registration
  | "give_name"        // entities: { nombre: string }
  | "want_register"
  // Documents
  | "skip_doc"
  | "ask_progress"
  | "want_interview"
  | "send_doc"         // detected by media presence, not text
  // Questions (out-of-flow)
  | "ask_question"     // entities: { question: string }
  // Greeting
  | "greeting"
  // Unknown
  | "unknown";

// ─── NLU Result ──────────────────────────────────────────────────────────────

export interface NLUResult {
  intent: Intent;
  entities: Record<string, any>;
  confidence: number;
}

// ─── Vision / Document ───────────────────────────────────────────────────────

export interface DocDefinition {
  key: string;
  label: string;
  visualId: string;
  extract: string;
  crossCheck: string;
}

export interface VisionResult {
  detected_type: string;       // "ine_frente" | "ine_reverso" | "unknown" | ...
  matches_expected: boolean;   // true if detected_type === expected_type
  is_legible: boolean;         // quality check
  extracted_data: Record<string, string>;
  cross_check_flags: string[]; // ["nombre_mismatch", "expired", ...]
  confidence: number;          // 0-1
  rejection_reason?: string;   // "Image is blurry", "Not an INE", etc.
}

// ─── Prospect State Machine ─────────────────────────────────────────────────

export type ProspectState =
  | "idle"
  | "prospect_fuel_type"
  | "prospect_consumo"
  | "prospect_show_models"
  | "prospect_select_model"
  | "prospect_tank"            // GNV only — reuse vs new kit
  | "prospect_corrida"
  | "prospect_name"
  | "docs_capture"
  | "interview_ready"
  | "interview_q1"
  | "interview_q2"
  | "interview_q3"
  | "interview_q4"
  | "interview_q5"
  | "interview_q6"
  | "interview_q7"
  | "interview_q8"
  | "interview_complete"
  | "completed";

// ─── Conversation Context (Agent v3) ────────────────────────────────────────

export interface AgentContext {
  // Profile
  fuelType?: "gnv" | "gasolina";
  consumoLeq?: number;          // LEQ/mes (direct or converted from pesos)
  gastoPesosMes?: number;       // pesos/mes if gasolina

  // Model selection
  selectedModel?: {
    marca: string;
    modelo: string;
    anio: number;
  };
  pvBase?: number;              // price from vehicles_inventory

  // Tank decision (GNV only)
  reuseTank?: boolean;          // true = reuse, false = new kit (+$9,400)

  // Corrida
  corridaResumen?: string;      // WhatsApp-formatted corrida text

  // Registration
  nombre?: string;              // full name
  folio?: string;
  originationId?: number;
  taxistaId?: number;

  // Document capture
  docsCollected?: string[];     // keys of docs already captured
  currentDocIndex?: number;     // index into DOC_ORDER
  existingData?: Record<string, any>; // accumulated OCR data for cross-check

  // Interview
  interviewState?: {
    folioId: string;
    currentQuestion: number;
    answers: Record<string, any>;
    transcripts: any[];
  };

  // Canal
  canal?: string;

  // Misc
  profileName?: string;         // WhatsApp profile name
}

// ─── State Handler ───────────────────────────────────────────────────────────

export interface StateHandlerResult {
  response: string;
  newState?: ProspectState;
  contextUpdates?: Partial<AgentContext>;
}

/**
 * A state handler processes the user's message within a given state
 * and returns a response + optional state transition.
 */
export type StateHandler = (
  body: string,
  mediaUrl: string | null,
  mediaType: string | null,
  context: AgentContext,
  nluResult: NLUResult,
) => Promise<StateHandlerResult>;

// ─── Model Summary (for templates) ──────────────────────────────────────────

export interface ModelSummary {
  name: string;
  precio: number;
  cuotaM3: number;
  bolsillo: number;
  mesGnvLabel: string;
}

// ─── Corrida Summary (for templates) ────────────────────────────────────────

export interface CorridaResumen {
  resumenWhatsApp: string;
}
