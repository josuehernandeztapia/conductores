/**
 * CMU WhatsApp Agent v3 — RAG (Knowledge Base + FAQ)
 *
 * Answers prospect questions without breaking the state machine flow.
 * Three-tier approach:
 *   1. Regex FAQ match (pre-written answers, instant)
 *   2. Keyword search in business_rules DB table
 *   3. LLM with business_rules context (last resort)
 *
 * If nothing found → returns null (orchestrator uses fallback template).
 */

import { neon } from "@neondatabase/serverless";
import OpenAI from "openai";

// ─── Pre-Written FAQ ─────────────────────────────────────────────────────────

interface FAQEntry {
  patterns: RegExp[];
  answer: string;
}

const FAQ: FAQEntry[] = [
  {
    patterns: [
      /adelant(?:ar|o)\s*pagos?/i,
      /pago\s*anticipad/i,
      /pagar\s*(?:m[aá]s|antes|adelantad)/i,
      /abono\s*(?:a\s*)?capital/i,
    ],
    answer: "Sí, cualquier pago extra abona directamente a capital. Eso reduce tu cuota mensual (amortización alemana). No hay penalización por pago anticipado.",
  },
  {
    patterns: [
      /enferm(?:o|edad|e)/i,
      /accidente/i,
      /no\s+pued(?:o|a)\s+trabajar/i,
      /incapacidad/i,
      /hospital/i,
    ],
    answer: "El Fondo de Garantía (FG) cubre contingencias. Si no puedes trabajar temporalmente, CMU evalúa tu caso. El FG acumula $334/mes hasta $20,000 y se te devuelve en el mes 37 si no lo usaste.",
  },
  {
    patterns: [
      /cambi(?:ar|o)\s*(?:de\s*)?chofer/i,
      /otro\s+chofer/i,
      /poner\s+(?:otro\s+)?chofer/i,
    ],
    answer: "Sí, puedes cambiar de chofer notificando a CMU. El nuevo chofer necesita INE vigente y licencia de conducir con categoría de transporte.",
  },
  {
    patterns: [
      /seguro/i,
      /p[oó]liza/i,
      /asegur/i,
    ],
    answer: "El vehículo CMU incluye seguro vehicular durante los 36 meses del programa. CMU gestiona la póliza. En caso de siniestro, se activa el Fondo de Garantía.",
  },
  {
    patterns: [
      /bi[\s-]*combustible/i,
      /dos\s*combustible/i,
      /gasolina\s*y\s*gas/i,
      /gas\s*y\s*gasolina/i,
    ],
    answer: "El vehículo CMU opera con gas natural (GNV). El kit permite también usar gasolina como respaldo. La mayoría de taxistas usa 95% GNV porque es más barato.",
  },
  {
    patterns: [
      /cu[aá]ndo\s+(?:es|ser[aá]|va\s+a\s+ser)\s+m[ií]o/i,
      /cu[aá]ndo\s+(?:me\s+)?queda\s+(?:el\s+)?(?:carro|veh[ií]culo|taxi)/i,
      /mes\s+37/i,
      /a\s+nombre\s+m[ií]o/i,
      /escritura/i,
    ],
    answer: "En el mes 37, al liquidar el último pago, el vehículo se pone 100% a tu nombre. Te devolvemos el Fondo de Garantía acumulado (~$20,000).",
  },
  {
    patterns: [
      /anticipo|enganche/i,
    ],
    answer: "No hay anticipo ni enganche inicial. En el día 56 (mes 2) vendes tu taxi actual y esos $50,000 se abonan a capital, lo que reduce tu cuota mensual del mes 3 en adelante.",
  },
  {
    patterns: [
      /fondo\s*de\s*garant[ií]a/i,
      /\bfg\b/i,
    ],
    answer: "El Fondo de Garantía (FG) son $8,000 iniciales + $334/mes, tope $20,000. Es un seguro: cubre si no puedes trabajar o hay siniestro. Si llegas al mes 37 sin usarlo, se te devuelve completo.",
  },
  {
    patterns: [
      /qu[eé]\s+(?:es|hace)\s+cmu/i,
      /c[oó]mo\s+funciona\s+(?:el\s+)?programa/i,
      /en\s+qu[eé]\s+consiste/i,
      /expl[ií]came/i,
    ],
    answer: "CMU (Conductores del Mundo) te ofrece un taxi seminuevo con kit de gas natural. Pagas una cuota mensual que va bajando cada mes (amortización alemana). El recaudo por GNV cubre parte o toda tu cuota. En 36 meses el vehículo es tuyo.",
  },
  {
    patterns: [
      /requisitos/i,
      /qu[eé]\s+necesito/i,
      /qu[eé]\s+(?:me\s+)?pid(?:en|es)/i,
    ],
    answer: "Necesitas: INE vigente, tarjeta de circulación, factura de tu taxi actual, constancia de situación fiscal (SAT), comprobante de domicilio reciente, concesión de taxi, estado de cuenta bancario, historial de cargas GNV, carta de membresía de agrupación, y selfie con tu INE. Todo se manda por foto aquí por WhatsApp.",
  },
  {
    patterns: [
      /mora|(?:no|si\s+no)\s+pag(?:o|ar)/i,
      /(?:qu[eé]\s+pasa\s+si|y\s+si)\s+no\s+pag/i,
      /atraso/i,
    ],
    answer: "Si te atrasas en un pago, primero se usa el Fondo de Garantía. CMU te contacta para reestructurar. El objetivo es que completes los 36 meses, no quitarte el carro. Pero si hay incumplimiento grave, se aplica la cláusula de rescisión del contrato.",
  },
  {
    patterns: [
      /aguascalientes/i,
      /qu[eé]\s+(?:ciudad|estado|zona)/i,
      /d[oó]nde\s+(?:es|est[aá]n|operan)/i,
    ],
    answer: "CMU opera actualmente solo en Aguascalientes, Ags. Los taxistas deben tener concesión en Aguascalientes.",
  },
  {
    patterns: [
      /kit\s*(?:de\s*)?(?:gnv|gas)/i,
      /equipo\s*(?:de\s*)?gas/i,
      /instalaci[oó]n\s*(?:de\s*)?gas/i,
    ],
    answer: "El kit de gas natural viene incluido en el programa. Si ya tienes tanque en buen estado, puedes reusarlo sin costo. Si necesitas equipo nuevo, el costo es $9,400 que se suma al precio del vehículo.",
  },
  {
    patterns: [
      /cu[aá]nto\s+(?:voy\s+a\s+)?pag(?:o|ar)/i,
      /mensualidad/i,
      /cuota/i,
    ],
    answer: "La cuota depende del vehículo que elijas y tu consumo de GNV. A mayor consumo, más cubre el recaudo. Ejemplo: con 400 LEQ/mes, la cuota del mes 3 puede ser ~$5,200 y GNV cubre ~$4,400 → de tu bolsillo ~$1,100. ¿Quieres que calculemos con tus números?",
  },
];

// ─── Tier 1: Regex FAQ ──────────────────────────────────────────────────────

function matchFAQ(question: string): string | null {
  const lower = question.toLowerCase().trim();
  for (const entry of FAQ) {
    for (const pattern of entry.patterns) {
      if (pattern.test(lower)) {
        return entry.answer;
      }
    }
  }
  return null;
}

// ─── Tier 2: Business Rules DB ───────────────────────────────────────────────

interface BusinessRule {
  id: number;
  categoria: string;
  titulo: string;
  contenido: string;
  keywords: string[];
}

async function searchBusinessRules(question: string): Promise<BusinessRule[]> {
  try {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return [];

    const sql = neon(dbUrl);

    // Extract keywords from question (remove stop words)
    const stopWords = new Set([
      "que", "qué", "como", "cómo", "cuando", "cuándo", "donde", "dónde",
      "por", "para", "con", "sin", "de", "del", "la", "el", "los", "las",
      "un", "una", "unos", "unas", "es", "son", "ser", "hay", "tiene",
      "puede", "puedo", "se", "me", "mi", "si", "no", "ya", "más", "muy",
      "al", "en", "lo", "le", "les", "a", "y", "o", "u", "e",
    ]);

    const words = question.toLowerCase()
      .replace(/[¿?¡!.,;:]/g, "")
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    if (words.length === 0) return [];

    // Search by keyword overlap
    const searchTerm = words.join(" | ");
    const rows = await sql`
      SELECT id, categoria, titulo, contenido, keywords
      FROM business_rules
      WHERE activo = true
        AND (
          to_tsvector('spanish', contenido) @@ to_tsquery('spanish', ${searchTerm})
          OR to_tsvector('spanish', titulo) @@ to_tsquery('spanish', ${searchTerm})
        )
      ORDER BY ts_rank(to_tsvector('spanish', contenido), to_tsquery('spanish', ${searchTerm})) DESC
      LIMIT 3
    `;

    return rows as BusinessRule[];
  } catch (error: any) {
    console.error("[RAG] Business rules search failed:", error.message);
    return [];
  }
}

// ─── Tier 3: LLM with Context ───────────────────────────────────────────────

async function answerWithLLM(question: string, rules: BusinessRule[]): Promise<string | null> {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const rulesContext = rules.length > 0
      ? rules.map(r => `[${r.categoria}] ${r.titulo}: ${r.contenido}`).join("\n\n")
      : "No hay reglas de negocio relevantes encontradas.";

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Eres el asistente de CMU (Conductores del Mundo), un programa de renovación de taxis en Aguascalientes, México.
Responde la pregunta del taxista usando SOLO la información proporcionada. Si no tienes suficiente info, di que no tienes esa información.
Respuesta corta (2-3 líneas), español coloquial mexicano. NO inventes datos ni números.

REGLAS DE NEGOCIO:
${rulesContext}`,
        },
        { role: "user", content: question },
      ],
      max_tokens: 200,
      temperature: 0.3,
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (text && text.length > 10) return text;
    return null;
  } catch (error: any) {
    console.error("[RAG] LLM answer failed:", error.message);
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Answer a prospect's question using FAQ, business rules, or LLM fallback.
 * Returns the answer string, or null if nothing found.
 */
export async function answerQuestion(question: string): Promise<string | null> {
  if (!question || question.trim().length < 3) return null;

  // Tier 1: pre-written FAQ (instant, most reliable)
  const faqAnswer = matchFAQ(question);
  if (faqAnswer) return faqAnswer;

  // Tier 2: search business_rules table
  const rules = await searchBusinessRules(question);
  if (rules.length > 0) {
    // If we got a very clear single rule, return it directly
    if (rules.length === 1 && rules[0].contenido.length < 300) {
      return rules[0].contenido;
    }
    // Otherwise, use LLM to synthesize
    const llmAnswer = await answerWithLLM(question, rules);
    if (llmAnswer) return llmAnswer;
  }

  // Tier 3: LLM with empty context (last resort)
  const llmAnswer = await answerWithLLM(question, []);
  if (llmAnswer) return llmAnswer;

  // Nothing found
  return null;
}
