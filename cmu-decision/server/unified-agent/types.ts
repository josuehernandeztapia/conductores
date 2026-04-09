/**
 * Unified State Machine for CMU WhatsApp Agent
 * Phase 3: Combines ProspectState (v4) and ConversationState (v9)
 */

// ===== UNIFIED STATE TYPE =====
export type UnifiedState =
  // Common states
  | "idle"

  // Prospect flow (from v4 orchestrator)
  | "prospect_name"
  | "prospect_fuel_type"
  | "prospect_consumo"
  | "prospect_show_models"
  | "prospect_select_model"
  | "prospect_tank"
  | "prospect_corrida"
  | "prospect_confirm"

  // Document capture (shared)
  | "docs_capture"
  | "docs_pending"
  | "capturing_docs_existing"  // For existing clients updating docs

  // Interview flow
  | "interview_ready"
  | "interview_q1" | "interview_q2" | "interview_q3" | "interview_q4"
  | "interview_q5" | "interview_q6" | "interview_q7" | "interview_q8"
  | "interview_complete"

  // Post-registration states (from v9)
  | "active_client"        // Client with active loan
  | "evaluating"          // Director evaluating vehicle
  | "browsing_prices"     // Looking at market prices
  | "asking_info"         // FAQ flow
  | "simulation"          // Running payment simulation
  | "awaiting_variant"    // Waiting for variant selection
  | "awaiting_inventory_pin"  // Director editing inventory

  // Terminal state
  | "completed";

// ===== UNIFIED CONTEXT =====
export interface UnifiedContext {
  // User identity
  phone: string;
  role: "prospect" | "cliente" | "promotora" | "director" | "proveedor" | "dev";
  name?: string;
  profileName?: string;

  // Prospect data (from v4 AgentContext)
  fuelType?: "gnv" | "gasolina";
  consumoLeq?: number;
  gastoPesosMes?: number;
  selectedModel?: {
    marca: string;
    modelo: string;
    anio: number;
    variante?: string;
  };
  pvBase?: number;
  reuseTank?: boolean;
  corridaResumen?: string;

  // Registration data
  folio?: string;
  originationId?: number;
  taxistaId?: number;
  otpSent?: boolean;
  otpVerified?: boolean;

  // Document capture
  docsCollected?: string[];
  skippedDocs?: string[];
  currentDocIndex?: number;
  existingData?: Record<string, any>;

  // Interview
  interviewState?: {
    folioId: string;
    currentQuestion: number;
    answers: Record<string, any>;
    transcripts: any[];
  };

  // Evaluation context (from v9)
  eval?: {
    cost?: number;
    repair?: number;
    conTanque?: boolean;
    marketAvg?: number;
  };

  // Active loan context
  loan?: {
    product: "taxi" | "kit" | "ahorro";
    vehicleId?: number;
    monthlyPayment?: number;
    balance?: number;
    nextDueDate?: string;
  };

  // Conversation memory
  lastTopic?: string;
  lastModel?: any;  // Last evaluated model
  pendingCorrida?: string;
  pendingEdit?: Record<string, any>;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

// ===== STATE TRANSITION RULES =====
export const VALID_TRANSITIONS: Record<UnifiedState, UnifiedState[]> = {
  "idle": [
    "prospect_name",
    "prospect_fuel_type",
    "active_client",
    "evaluating",
    "browsing_prices",
    "asking_info"
  ],

  // Prospect flow
  "prospect_name": ["prospect_fuel_type", "idle"],
  "prospect_fuel_type": ["prospect_consumo", "idle"],
  "prospect_consumo": ["prospect_show_models", "idle"],
  "prospect_show_models": ["prospect_select_model", "idle"],
  "prospect_select_model": ["prospect_tank", "prospect_corrida"],
  "prospect_tank": ["prospect_corrida", "idle"],
  "prospect_corrida": ["prospect_confirm", "idle"],
  "prospect_confirm": ["docs_capture", "idle"],

  // Document flow
  "docs_capture": ["docs_pending", "interview_ready", "idle"],
  "docs_pending": ["docs_capture", "interview_ready", "idle"],
  "capturing_docs_existing": ["active_client", "idle"],

  // Interview flow
  "interview_ready": ["interview_q1", "idle"],
  "interview_q1": ["interview_q2", "interview_ready"],
  "interview_q2": ["interview_q3", "interview_q1"],
  "interview_q3": ["interview_q4", "interview_q2"],
  "interview_q4": ["interview_q5", "interview_q3"],
  "interview_q5": ["interview_q6", "interview_q4"],
  "interview_q6": ["interview_q7", "interview_q5"],
  "interview_q7": ["interview_q8", "interview_q6"],
  "interview_q8": ["interview_complete", "interview_q7"],
  "interview_complete": ["completed", "active_client"],

  // Post-registration states
  "active_client": [
    "evaluating",
    "browsing_prices",
    "simulation",
    "capturing_docs_existing",
    "idle"
  ],
  "evaluating": ["active_client", "simulation", "idle"],
  "browsing_prices": ["evaluating", "active_client", "idle"],
  "asking_info": ["prospect_name", "active_client", "idle"],
  "simulation": ["active_client", "idle"],
  "awaiting_variant": ["evaluating", "idle"],
  "awaiting_inventory_pin": ["active_client", "idle"],

  // Terminal
  "completed": ["idle", "active_client"]
};

// ===== INTENT DETECTION =====
export interface StateIntent {
  nextState: UnifiedState;
  confidence: number;
  entities?: Record<string, any>;
}

export type StateHandler = (
  context: UnifiedContext,
  input: string,
  mediaUrl?: string | null
) => Promise<{
  nextState: UnifiedState;
  response: string;
  contextUpdates?: Partial<UnifiedContext>;
}>;