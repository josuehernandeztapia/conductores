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
import { chatCompletion } from "./openai-helper";
import { buildClientKnowledge } from "../cmu-knowledge";
import { getBusinessRules } from "../business-rules";


// ─── Pre-Written FAQ ─────────────────────────────────────────────────────────

interface FAQEntry {
  patterns: RegExp[];
  answer: string;
}

const FAQ: FAQEntry[] = [
  {
    patterns: [
      /cu[aá]les\s+(?:son\s+)?(?:los\s+)?(?:14\s+)?document/i,
      /qu[eé]\s+document/i,
      /lista\s+(?:de\s+)?document/i,
      /14\s+document/i,
      /qu[eé]\s+(?:me\s+)?(?:van\s+a\s+)?pedir/i,
      /qu[eé]\s+necesit/i,
    ],
    answer: "Los 14 documentos son:\n\n1. INE frente\n2. INE reverso\n3. Tarjeta de circulación\n4. Factura del vehículo\n5. Constancia de Situación Fiscal (CSF)\n6. Comprobante de domicilio\n7. Concesión de taxi\n8. Estado de cuenta bancario\n9. Tickets/historial de GNV (o gasolina)\n10. Carta de membresía gremial\n11. Selfie con tu INE\n12. INE del operador (si tienes chofer)\n13. Licencia del operador\n14. Fotos de tu unidad (4 fotos)\n\nTe voy pidiendo uno por uno. Si no tienes alguno, escribe *siguiente* para saltarlo.",
  },
  {
    patterns: [
      /(?:puedo|quiero)\s+(?:enviar|mandar)\s+(?:la\s+)?(?:factura|doc|foto)/i,
      /te\s+(?:puedo|quiero)\s+(?:enviar|mandar)/i,
      /(?:mand|envi)\s*(?:ar)?(?:te)?\s+(?:la\s+)?(?:factura|doc|foto)/i,
    ],
    answer: "Claro, mándamela aquí mismo por foto. Solo tómale una foto al documento y envíala.",
  },
  {
    patterns: [
      /qu[eé]\s+es\s+(?:la\s+)?(?:csf|constancia|situaci[oó]n\s+fiscal)/i,
      /c[oó]mo\s+(?:saco|consigo|obtengo)\s+(?:la\s+)?(?:csf|constancia)/i,
    ],
    answer: "La *CSF* (Constancia de Situación Fiscal) es un documento del SAT que confirma tu RFC y régimen fiscal. La sacas gratis en sat.gob.mx con tu RFC y contraseña, o tu contador te la puede dar. Debe tener máximo 30 días de emitida.",
  },
  {
    patterns: [
      /qu[eé]\s+es\s+(?:la\s+)?clabe/i,
      /qu[eé]\s+es\s+una\s+clabe/i,
      /d[oó]nde\s+(?:encuentro|est[aá]|viene|saco)\s+(?:la\s+)?clabe/i,
    ],
    answer: "La *CLABE* es tu número de cuenta interbancaria de 18 dígitos. La encuentras en tu estado de cuenta bancario (la primera página/carátula) o en tu app del banco. NO es el número de tarjeta.",
  },
  {
    patterns: [
      /qu[eé]\s+es\s+(?:la\s+)?concesi[oó]n/i,
      /d[oó]nde\s+(?:saco|consigo)\s+(?:la\s+)?concesi[oó]n/i,
    ],
    answer: "La *concesión* es el permiso del gobierno estatal que te autoriza a operar como taxi. Es un documento grande con el escudo del estado y tu número de concesión. Si no la tienes, puedes pedirla en la Secretaría de Movilidad de Aguascalientes.",
  },
  {
    patterns: [
      /qu[eé]\s+es\s+(?:el\s+)?(?:estado\s+de\s+cuenta|estado.*bancario)/i,
      /qu[eé]\s+(?:parte|p[aá]gina)\s+del\s+estado/i,
    ],
    answer: "Necesito la *primera página (carátula)* de tu estado de cuenta bancario. Es donde aparece tu nombre, número de cuenta, CLABE a 18 dígitos, y dirección. Puede ser de cualquier banco. Si usas app bancaria, ahí lo puedes descargar.",
  },
  {
    patterns: [
      /qu[eé]\s+es\s+(?:la\s+)?(?:carta|membres[ií]a)\s+gremial/i,
      /d[oó]nde\s+(?:saco|consigo)\s+(?:la\s+)?carta/i,
    ],
    answer: "La *Carta de Membresía Gremial* es el documento de tu agrupación de taxis (ACATAXI, CTM, etc.) que confirma que eres miembro activo. Pídela en tu sindicato o agrupación.",
  },
  {
    patterns: [
      /qu[eé]\s+(?:fotos|foto)\s+(?:del|de la|de mi)?\s*(?:taxi|unidad|carro)/i,
      /c[oó]mo\s+(?:tomo|le\s+tomo)\s+(?:las\s+)?fotos/i,
    ],
    answer: "Necesito *4 fotos de tu taxi*: frente, trasera, lateral izquierdo y lateral derecho. Tómalas de día, que se vea bien la unidad completa. Si se ve la placa, mejor.",
  },
  {
    patterns: [
      /qu[eé]\s+es\s+(?:la\s+)?selfie/i,
      /c[oó]mo\s+(?:me\s+)?tomo\s+la\s+selfie/i,
    ],
    answer: "Necesito una *selfie tuya sosteniendo tu INE al lado de tu cara*. Con buena luz, que se vea tu rostro y los datos de la INE legibles. Es para verificar que tú eres el titular.",
  },
  {
    patterns: [
      /(?:puedo|quiero)\s+hablar\s+con\s+(?:alguien|persona|asesor|humano)/i,
      /hay\s+(?:alguien|una\s+persona)\s+(?:real|que me atienda)/i,
      /(?:at[eé]nder|hablar).*(?:persona|humano|asesor)/i,
    ],
    answer: "Claro, tu promotora te puede atender personalmente. Le aviso que necesitas apoyo. Mientras tanto, si tienes documentos listos, mándamelos aquí — yo los proceso al instante.",
  },
  {
    patterns: [
      /cu[aá]ndo\s+(?:me\s+)?(?:dan|entregan|tengo)\s+(?:el\s+)?(?:carro|taxi|veh[ií]culo|respuesta)/i,
      /cu[aá]nto\s+(?:se\s+)?tarda/i,
    ],
    answer: "Una vez que tengamos tu expediente completo (14 docs + entrevista), lo revisamos en 24-48 horas y te damos respuesta. Si todo sale bien, la entrega del vehículo es en unas 2-3 semanas.",
  },
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
  {
    patterns: [/aval/i, /fiador/i, /garant[ií]a\s+personal/i, /obligado\s+solidario/i],
    answer: "No se necesita aval ni fiador. CMU no pide garantías personales. Solo tu concesión vigente y tus documentos.",
  },
  {
    patterns: [/m[aá]s\s+de\s+50/i, /dar\s+m[aá]s/i, /abonar\s+m[aá]s/i, /anticipo\s+mayor/i],
    answer: "Sí, puedes dar más de $50,000 de anticipo. Todo se abona a capital y tu cuota baja aún más. El mínimo es $50,000 pero no hay tope.",
  },
  {
    patterns: [/56\s*d[ií]as/i, /no\s+vend/i, /m[aá]s\s+tiempo/i, /extender.*plazo/i, /pr[oó]rroga/i],
    answer: "Si necesitas más tiempo para vender tu taxi, habla con CMU antes del día 56. Se puede extender sin penalización. Lo importante es comunicarte, no desaparecer.",
  },
  {
    patterns: [/bur[oó]/i, /historial\s+credit/i, /checan.*bur/i, /revisan.*bur/i],
    answer: "No revisamos buró de crédito. CMU es venta a plazos, no crédito bancario. Evaluamos tu operación como taxista y tu consumo de combustible.",
  },
  {
    patterns: [/mora/i, /no\s+pag/i, /atras/i, /qu[eé].*si.*no.*pago/i],
    answer: "Si tu recaudo GNV no cubre la cuota, tienes 5 días para pagar el diferencial. Si no, el Fondo de Garantía cubre automáticamente. Si el FG se agota, hay recargo de $250 + 2% mensual. Tres meses sin regularizar = rescisión.",
  },
  {
    patterns: [/promotor/i, /asesor/i, /en\s+persona/i, /oficina/i, /presencial/i],
    answer: "Si prefieres ayuda en persona, nuestro promotor puede asistirte con los documentos y resolver tus dudas. Solo dime y te lo conecto.",
  },
  {
    patterns: [/reserva.*dominio/i, /a\s+nombre\s+de\s+qui[eé]n/i, /de\s+qui[eé]n.*carro/i],
    answer: "El vehículo queda a nombre de CMU hasta que pagues la última cuota (mes 36). Tú lo usas, lo aseguras y lo operas. Al liquidar, CMU te transfiere el dominio y es 100% tuyo.",
  },
  {
    patterns: [/liquidar.*antes/i, /pagar.*todo/i, /anticip.*liquidar/i, /saldo.*insoluto/i],
    answer: "Sí, puedes liquidar el saldo en cualquier momento sin penalización. Contacta a CMU para obtener tu saldo de liquidación y al pagar se te transfiere el vehículo.",
  },
  {
    patterns: [/donde.*pag/i, /c[oó]mo.*pag/i, /clabe/i, /oxxo/i, /conekta/i, /transferencia/i],
    answer: "Puedes pagar por liga de pago (OXXO, transferencia o tarjeta), o directo a la CLABE 152680120000787681 (Bancrea) con tu folio de referencia. Te llega la liga por WhatsApp cada mes.",
  },
  {
    patterns: [/siniestro/i, /choque/i, /accidente.*carro/i],
    answer: "Es tu responsabilidad mantener seguro vehicular vigente los 36 meses. En caso de siniestro, el seguro cubre la unidad. Tú eliges la aseguradora.",
  },
  {
    patterns: [/concesi[oó]n/i, /vigente/i, /no\s+tengo\s+concesi/i],
    answer: "Necesitas ser titular de una concesión de taxi vigente en Aguascalientes. Si la concesión está a nombre de otra persona, el titular es quien debe solicitar.",
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
  category: string;
  key: string;
  value: string;
  description: string | null;
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
      SELECT id, category, key, value, description
      FROM business_rules
      WHERE
        to_tsvector('spanish', value) @@ to_tsquery('spanish', ${searchTerm})
        OR to_tsvector('spanish', COALESCE(description, '')) @@ to_tsquery('spanish', ${searchTerm})
        OR to_tsvector('spanish', key) @@ to_tsquery('spanish', ${searchTerm})
      ORDER BY ts_rank(to_tsvector('spanish', value), to_tsquery('spanish', ${searchTerm})) DESC
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
    // Build full knowledge base from SSOT + business_rules
    let knowledgeBase: string;
    try {
      const rulesMap = await getBusinessRules();
      knowledgeBase = buildClientKnowledge(rulesMap);
    } catch {
      // Fallback to just the DB rules
      knowledgeBase = rules.length > 0
        ? rules.map(r => `[${r.category}] ${r.key}: ${r.value}`).join("\n\n")
        : "";
    }

    const text = await chatCompletion(
      [
        {
          role: "system",
          content: `Eres el asistente de CMU (Conductores del Mundo), un programa de renovación de taxis en Aguascalientes.
Responde la pregunta del taxista usando SOLO la información del knowledge base. Si no encuentras la respuesta, di "No tengo esa información, pero tu asesor CMU te puede ayudar."
Respuesta corta (2-3 líneas), español coloquial mexicano. Amigable y directo. NO inventes datos.

KNOWLEDGE BASE CMU:
${knowledgeBase}`,
        },
        { role: "user", content: question },
      ],
      { max_tokens: 250, temperature: 0.2 },
    );

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
    if (rules.length === 1 && (rules[0].value || (rules[0] as any).contenido || "").length < 300) {
      return rules[0].value || (rules[0] as any).contenido || "";
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
