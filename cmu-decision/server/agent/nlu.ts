/**
 * CMU WhatsApp Agent v3 — NLU (Natural Language Understanding)
 *
 * 80% regex-based (fast, deterministic, no LLM call).
 * 20% LLM fallback (only when regex can't determine intent).
 *
 * Detects: fuel type, numbers (LEQ, pesos), model names, affirmations,
 * denials, doc skip intent, interview intent, names (2+ words).
 */


import type { Intent, NLUResult } from "./types";
import { chatCompletion } from "./openai-helper";

// ─── Regex Patterns ──────────────────────────────────────────────────────────

const PATTERNS: Array<{ intent: Intent; regex: RegExp; entityExtractor?: (match: RegExpMatchArray, text: string) => Record<string, any> }> = [
  // ── Fuel type ──
  {
    intent: "fuel_gnv",
    regex: /\b(gas\s*natural|gnv|gas\b|ya\s+(tengo|uso|traigo)\s+gas|con\s+gas)\b/i,
  },
  {
    intent: "fuel_gasolina",
    regex: /\b(gasolina|nafta|con\s+gasolina|pura\s+gasolina|magna|premium)\b/i,
  },

  // ── Consumo: LEQ ──
  {
    intent: "consumo_number",
    regex: /(\d{2,4})\s*(leq|litros?\s*(equivalentes?)?|lts?|l\b)/i,
    entityExtractor: (match) => ({ leq: parseInt(match[1], 10) }),
  },
  // Bare number in consumo context (200-2000 range → LEQ)
  {
    intent: "consumo_number",
    regex: /^[\s]*(\d{3,4})[\s]*$/,
    entityExtractor: (match) => {
      const n = parseInt(match[1], 10);
      if (n >= 100 && n <= 2000) return { leq: n };
      return {};
    },
  },

  // ── Gasto: pesos ──
  {
    intent: "gasto_number",
    regex: /\$?\s*(\d{1,3}(?:[,.]?\d{3})*)\s*(pesos|varos|baro[s]?|al\s*mes|mensuales?|por\s*mes)/i,
    entityExtractor: (match) => ({ pesos: parseInt(match[1].replace(/[,.]/g, ""), 10) }),
  },
  // "como 3000" / "unos 5000"
  {
    intent: "gasto_number",
    regex: /(?:como|unos?|aprox(?:imadamente)?|m[aá]s\s+o\s+menos)\s+\$?\s*(\d{1,3}(?:[,.]?\d{3})*)/i,
    entityExtractor: (match, text) => {
      const n = parseInt(match[1].replace(/[,.]/g, ""), 10);
      // If contains "litros" or "leq", this is consumo, not gasto
      if (/litros?|leq/i.test(text)) return {};
      if (n >= 500 && n <= 30000) return { pesos: n };
      return {};
    },
  },
  // Bare peso number (1000-30000 range, no "litros" context)
  {
    intent: "gasto_number",
    regex: /^\$?\s*(\d{4,5})$/,
    entityExtractor: (match) => {
      const n = parseInt(match[1], 10);
      if (n >= 1000 && n <= 30000) return { pesos: n };
      return {};
    },
  },

  // ── Model selection ──
  {
    intent: "select_model",
    regex: /\b(aveo)\b/i,
    entityExtractor: () => ({ modelo: "Aveo" }),
  },
  {
    intent: "select_model",
    regex: /\b(march\s*sense|sense)\b/i,
    entityExtractor: () => ({ modelo: "March Sense" }),
  },
  {
    intent: "select_model",
    regex: /\b(march\s*advance|advance)\b/i,
    entityExtractor: () => ({ modelo: "March Advance" }),
  },
  {
    intent: "select_model",
    regex: /\b(kwid)\b/i,
    entityExtractor: () => ({ modelo: "Kwid" }),
  },
  {
    intent: "select_model",
    regex: /\b(i\s*10|i10|grand\s*i10|grand)\b/i,
    entityExtractor: () => ({ modelo: "i10" }),
  },
  {
    intent: "see_all_models",
    regex: /\b(todos?|ver\s+todos?|cu[aá]les\s+hay|qu[eé]\s+(?:hay|modelos|carros|opciones|vehic)|opciones|mostrar(?:me)?|lista)\b/i,
  },

  // ── Tank decision ──
  {
    intent: "reuse_tank",
    regex: /\b(reuso|reusar|reutil|mi\s+tanque|1️⃣|opci[oó]n\s*1|sin\s+costo)\b/i,
  },
  {
    intent: "new_tank",
    regex: /\b(equipo\s*nuevo|nuevo\s*equipo|kit\s*nuevo|nuevo\s*kit|2️⃣|opci[oó]n\s*2|nuevo)\b/i,
  },

  // ── Affirm / Deny ──
  {
    intent: "affirm",
    regex: /^[\s]*(s[ií]|sí?|claro|dale|va|órale|orale|si\s+quiero|empezar|listo|de\s+acuerdo|[oó]k|ok[ay]?|arre|simon|simón|va\s+pues|jalo|ándale|andale|a\s+darle|por\s+supuesto|me\s+interesa|adelante|va\s+va|afirmativo|me\s+late|le\s+entro|le\s+entramos|si\s+me\s+late|s[ií]\s+va|va\s+que\s+va|s[ií]\s+le\s+entro|s[ií]\s+me\s+interesa)[\s!.]*$/i,
  },
  {
    intent: "deny",
    regex: /^[\s]*(no\b|nel|nah|nop[e]?|para\s+nada|no\s+gracias|no\s+quiero|no\s+me\s+interesa|no\s+por\s+ahora)[\s!.]*$/i,
  },
  {
    intent: "maybe_later",
    regex: /\b(despu[eé]s|luego|m[aá]s\s+(?:tarde|adelante)|otro\s+d[ií]a|lo\s+pienso|d[eé]jame\s+pensar|ahora\s+no|no\s+ahorita|ahorita\s+no)\b/i,
  },

  // ── Doc skip / progress / interview intent ──
  {
    intent: "skip_doc",
    regex: /\b(soy\s+(?:yo\s+)?(?:el\s+)?(?:operador|chofer|conductor)|yo\s+(?:mismo\s+)?(?:manejo|opero|conduzco)|no\s+tengo\s+(?:operador|chofer))\b/i,
  },
  {
    intent: "skip_doc",
    regex: /\b(no\s+(?:la|lo|las|los)?\s*tengo|no\s+cuento|no\s+(?:lo\s+)?encuentro|ahorita\s+no|no\s+(?:la|lo)\s+tengo\s+(?:a\s+la\s+mano|conmigo|aqu[ií])|no\s+est[aá]\s+aqu[ií]|no\s+(?:la|lo)\s+traigo|despu[eé]s\s+(?:te|lo|la)\s+(?:mando|env[ií]o)|lo\s+busco|l[oa]\s+mando\s+(?:luego|despu[eé]s)|saltar|skip|brincar|no\s+tengo\s+eso|siguie?nte|sigiente|siguente|no\s+(?:la|lo)\s+tengo|no\s+(?:la|lo)\s+tengo\s+conmigo|no\s+(?:la|lo)\s+traigo\s+conmigo|no\s+(?:la|lo)\s+tengo\s+aqu[ií]|ahorita\s+no\s+(?:la|lo)\s+tengo|no\s+lo\s+tengo\s+(?:a\s+la|cer[ck]a))\b/i,
  },
  {
    intent: "ask_progress",
    regex: /\b(cu[aá]ntos?\s+(?:faltan|llevo|van)|cu[aá]nto\s+falta|qu[eé]\s+(?:me\s+)?falta[n]?|c[oó]mo\s+voy|mi\s+avance|mi\s+progreso|estado|cu[aá]les\s+(?:me\s+)?falta[n]?|que\s+(?:me\s+)?falta[n]?)\b/i,
  },
  {
    intent: "want_interview",
    regex: /\b(entrevista|empezar\s+entrevista|quiero\s+(?:la\s+)?entrevista|hagamos\s+(?:la\s+)?entrevista|hacemos\s+(?:la\s+)?entrevista|preguntas|empezamos)\b/i,
  },

  // ── Give name (2+ words, no numbers, state-dependent) ──
  {
    intent: "give_name",
    regex: /^([A-ZÁÉÍÓÚÑa-záéíóúñ]{2,}(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]{2,})+)$/,
    entityExtractor: (match) => {
      const name = match[1].trim();
      if (name.split(/\s+/).length < 2 || name.split(/\s+/).length > 5) return {};
      // Reject common phrases that are NOT names
      const lower = name.toLowerCase();
      const NOT_NAMES = [
        'ya no', 'no quiero', 'te dije', 'te quiero', 'no tengo', 'no puedo',
        'si quiero', 'me interesa', 'no estoy', 'ya tengo', 'quiero enviar',
        'pero me', 'est\u00e1 bien', 'esta bien', 'no gracias', 'ya no quiero',
        'ya estuvo', 'como le', 'la verdad', 'ni idea', 'no mames',
        'que onda', 'la neta', 'simon', 'nel', 'va va',
      ];
      if (NOT_NAMES.some(phrase => lower.includes(phrase))) return {};
      return { nombre: name };
    },
  },

  // ── Cancel / quit / don't want to continue ──
  {
    intent: "deny",
    regex: /\b(ya\s+no\s+quiero|no\s+quiero\s+(?:seguir|continuar)|quiero\s+(?:salir|parar|detener)|basta|par[ae]|d[ée]jalo|cancel[ae]r?|no\s+(?:me\s+)?interesa|olv[ií]dalo|ya\s+no)\b/i,
  },
  // ── Don't know / skip answer ──
  {
    intent: "unknown",
    regex: /^\s*(no\s*s[eé]|nos[eé]|ni\s*idea|no\s+tengo\s+idea|no\s+s[eé]\s+(?:cu[aá]nto|qu[eé]|c[oó]mo)|quien\s+sabe|pas[ao])\s*$/i,
  },

  // ── Interview navigation: go back / correct previous question ──
  {
    intent: "go_back",
    regex: /(?:regres[ae]|volver|vuelv[ea]|corregir|cambiar|repetir)\s+(?:a\s+)?(?:la\s+)?(?:pregunta\s*)?#?\s*(\d)/i,
    entityExtractor: (match) => ({ question_number: parseInt(match[1], 10) }),
  },
  {
    intent: "go_back",
    regex: /(?:quiero\s+)?(?:corregir|cambiar|repetir)\s+(?:la\s+)?(?:respuesta|pregunta)\s+(?:anterior|pasada|de\s+antes)/i,
    entityExtractor: () => ({ question_number: -1 }),
  },
  {
    intent: "go_back",
    regex: /(?:la\s+)?(?:pregunta|respuesta)\s+(?:anterior|pasada)\b/i,
    entityExtractor: () => ({ question_number: -1 }),
  },
  {
    intent: "go_back",
    regex: /(?:te\s+dije|ya\s+te\s+dije|no\s*,?\s*(?:yo\s+)?(?:dije|te\s+dije)|eso\s+no\s+(?:es|fue)|(?:est[aá]|estuvo)\s+mal|me\s+entendiste\s+mal|no\s+(?:era|es)\s+(?:eso|as[ií])|quise\s+decir)/i,
    entityExtractor: () => ({ question_number: -1 }),
  },

  // ── Want to register ──
  {
    intent: "want_register",
    regex: /\b(quiero\s+(?:empezar|registrar|iniciar)|inscrib|apunt|registr[ae]|empezar\s+(?:el\s+)?proceso|d[oó]nde\s+(?:me\s+)?(?:registro|inscribo))\b/i,
  },

  // ── Greeting ──
  {
    intent: "greeting",
    regex: /^[\s]*(hola|buenos?\s+(?:d[ií]as?|tardes?|noches?)|buenas|hey|qu[eé]\s+tal|que\s+tal|oye|buen\s+d[ií]a)[\s!.,]*$/i,
  },

  // ── Questions (fallback pattern — catches "¿...?" and "qué/cómo/cuándo/por qué..." ──
  {
    intent: "ask_question",
    regex: /(?:\?|¿|^(?:qu[eé]|c[oó]mo|cu[aá]ndo|cu[aá]nto|por\s*qu[eé]|d[oó]nde|qui[eé]n|puedo|se\s+puede|es\s+posible)\s+)/i,
    entityExtractor: (_match, text) => ({ question: text.trim() }),
  },
];

// ─── Regex-Based Extraction ──────────────────────────────────────────────────

function extractByRegex(body: string, state: string): NLUResult | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  // State-aware priority: in certain states, prefer certain intents
  const priorityIntents = getStatePriority(state);

  // First pass: check priority intents for the current state
  if (priorityIntents.length > 0) {
    for (const pattern of PATTERNS) {
      if (!priorityIntents.includes(pattern.intent)) continue;
      const match = trimmed.match(pattern.regex);
      if (match) {
        const entities = pattern.entityExtractor ? pattern.entityExtractor(match, trimmed) : {};
        // Skip if entity extractor returned empty (failed validation)
        if (pattern.entityExtractor && Object.keys(entities).length === 0) continue;
        return { intent: pattern.intent, entities, confidence: 0.9 };
      }
    }
  }

  // Second pass: all patterns in order
  for (const pattern of PATTERNS) {
    const match = trimmed.match(pattern.regex);
    if (match) {
      const entities = pattern.entityExtractor ? pattern.entityExtractor(match, trimmed) : {};
      if (pattern.entityExtractor && Object.keys(entities).length === 0) continue;
      return { intent: pattern.intent, entities, confidence: 0.85 };
    }
  }

  return null;
}

/**
 * State-aware priority: which intents to check first based on the current state.
 */
function getStatePriority(state: string): Intent[] {
  switch (state) {
    case "idle":
    case "prospect_fuel_type":
      return ["fuel_gnv", "fuel_gasolina", "greeting"];
    case "prospect_consumo":
      return ["consumo_number", "gasto_number"];
    case "prospect_show_models":
    case "prospect_select_model":
      return ["select_model", "see_all_models"];
    case "prospect_tank":
      return ["reuse_tank", "new_tank"];
    case "prospect_corrida":
      return ["affirm", "deny", "maybe_later", "want_register"];
    case "prospect_name":
      return ["give_name"];
    case "docs_capture":
      return ["skip_doc", "ask_progress", "want_interview"];
    case "interview_ready":
      return ["affirm", "want_interview"];
    case "interview_q1":
    case "interview_q2":
    case "interview_q3":
    case "interview_q4":
    case "interview_q5":
    case "interview_q6":
    case "interview_q7":
    case "interview_q8":
      return ["go_back"];
    default:
      return [];
  }
}

// ─── LLM Fallback ────────────────────────────────────────────────────────────

const VALID_INTENTS: Intent[] = [
  "fuel_gnv", "fuel_gasolina", "consumo_number", "gasto_number",
  "select_model", "see_all_models", "reuse_tank", "new_tank",
  "affirm", "deny", "maybe_later", "give_name", "want_register",
  "skip_doc", "ask_progress", "want_interview", "go_back", "ask_question",
  "greeting", "unknown",
];

async function extractByLLM(body: string, state: string): Promise<NLUResult> {
  try {

    const systemPrompt = `You classify WhatsApp messages from Mexican taxi drivers into intents.
Current conversation state: "${state}"

Valid intents: ${VALID_INTENTS.join(", ")}

Rules:
- "fuel_gnv" = user says they use natural gas (GNV)
- "fuel_gasolina" = user says they use gasoline
- "consumo_number" = user gives a number that represents LEQ per month. Extract as {"leq": N}
- "gasto_number" = user gives a peso amount for fuel expense. Extract as {"pesos": N}
- "select_model" = user mentions a specific vehicle model. Extract as {"modelo": "X"}
  Valid models: Aveo, March Sense, March Advance, Kwid, i10
- "give_name" = user gives their full name (2+ words). Extract as {"nombre": "Full Name"}
- "ask_question" = user is asking a question about the program. Extract as {"question": "their question"}
- "affirm" = yes, ok, si, dale, etc.
- "deny" = no, nope, etc.
- "skip_doc" = user says they don't have a document right now, it's not with them, not here, will send later. Examples: "no lo tengo", "no está aquí conmigo", "después te lo mando", "no la traigo", "siguiente"
- "want_interview" = user wants to start or continue the interview
- "go_back" = user wants to go back to a previous interview question or correct an answer. Extract as {"question_number": N} (1-8) or {"question_number": -1} for previous question
- "unknown" = you cannot determine the intent

Respond ONLY with valid JSON: {"intent": "...", "entities": {...}, "confidence": 0.N}`;

    const text = await chatCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: body },
      ],
      { max_tokens: 150, temperature: 0 },
    );
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const intent = VALID_INTENTS.includes(parsed.intent) ? parsed.intent : "unknown";
      return {
        intent,
        entities: parsed.entities || {},
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.6,
      };
    }
  } catch (error: any) {
    console.error("[NLU] LLM fallback failed:", error.message);
  }

  return { intent: "unknown", entities: {}, confidence: 0.1 };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract intent from user message.
 * 80% handled by regex. Falls back to LLM only when regex can't determine.
 */
export async function extractIntent(body: string, state: string): Promise<NLUResult> {
  // Empty body → unknown
  if (!body || !body.trim()) {
    return { intent: "unknown", entities: {}, confidence: 0 };
  }

  // Try regex first (fast, deterministic)
  const regexResult = extractByRegex(body, state);
  if (regexResult && regexResult.confidence >= 0.8) {
    return regexResult;
  }

  // LLM fallback
  const llmResult = await extractByLLM(body, state);

  // If both regex and LLM produced results, prefer higher confidence
  if (regexResult && regexResult.confidence > llmResult.confidence) {
    return regexResult;
  }

  return llmResult;
}
