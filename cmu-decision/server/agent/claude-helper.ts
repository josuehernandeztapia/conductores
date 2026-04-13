/**
 * claude-helper.ts — Claude API wrapper for CMU
 *
 * Replaces gpt-4o-mini calls with Claude Haiku for:
 * - NLU intent classification (5% of messages)
 * - RAG question answering
 * - Conversational fallback (promotora, director, cliente)
 *
 * Does NOT replace:
 * - Vision/OCR (stays GPT-4o — benchmark showed 90% vs 60% flag accuracy)
 * - Whisper transcription (Claude has no STT)
 */

import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY not set — falling back to OpenAI");
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

const MODEL = "claude-3-haiku-20240307";

// ─── Pre-training knowledge per module ───────────────────────────────────────

export const CMU_NLU_KNOWLEDGE = `
CONTEXTO OPERATIVO:
- Los usuarios son taxistas de Aguascalientes, México. Hablan español mexicano coloquial.
- Expresiones comunes: "mande", "oiga", "joven", "ey", "va", "sale", "nel", "órale", "simón".
- "8 mil" o "8000" en contexto de gasto = pesos mensuales de gasolina.
- "march" o "el march" = Nissan March. "aveo" = Chevrolet Aveo.
- "el azul", "el blanco" = referencia por color del vehículo en inventario.
- "ya estuvo" = afirmación. "nel" = negación. "sale pues" = afirmación.
- "no lo traigo" / "no está aquí conmigo" / "después te lo mando" = skip_doc (no tiene el documento a la mano).
- "siguiente" puede ser skip_doc O pedir el siguiente paso — depende del estado.
- "cuánto me sale" / "cuánto pagaría" = ask_question sobre simulación financiera.
- Un número solo (ej "8000") en estado prospect_consumo = gasto_number.
- Un número solo (ej "400") en estado prospect_consumo con fuel=gnv = consumo_number (LEQ/mes).
- "sense", "advance", "kwid", "i10", "vento", "versa" = select_model.
- Nombres mexicanos comunes: 2-4 palabras, solo letras. "Pedro López", "María de la Cruz Hernández".
- NO son nombres: "quiero información", "soy taxista", "gasolina", "bueno", "mande", "gracias".
`.trim();

export const CMU_RAG_KNOWLEDGE = `
PRODUCTO CMU — DATOS EXACTOS:
- Crédito a 36 meses, amortización ALEMANA (capital fijo, interés decreciente, cuota decreciente).
- Tasa anual: 29.9%.
- Anticipo: $50,000 (lo pone CMU, NO el taxista).
- Fondo de Garantía (FG): inicial $8,000 + $334/mes. Techo: $20,000.
- Kit GNV con tanque: $18,000. Sin tanque: $27,400.
- Sobreprecio GNV: $11/LEQ. Base: 400 LEQ/mes. Recaudo base: $4,400/mes.
- PV = min(mercado, max(catálogo, mercado × 0.95)) — NUNCA exceder mercado.
- El ahorro en GNV NO paga el vehículo completo. NUNCA decir "se paga solo" ni "sin sentirlo".
- Diferencial = cuota_mensual - recaudo_GNV + FG_mensual. Eso es lo que paga el taxista de su bolsillo.

COBRANZA:
- Corte: día 1 del mes.
- Fecha límite de pago: día 5.
- Si no paga día 6: se activa Fondo de Garantía (FG).
- Si FG se agota: mora activa con recargo desde día 8.
- Escalamiento a dirección: día 15.
- Recuperación del vehículo: día 30.
- Rescisión: 3 meses consecutivos sin pago.

OPERACIÓN:
- Solo Aguascalientes, México.
- Una promotora: Ángeles Mireles (60 años, no técnica).
- NATGAS = proveedor de gas, uso INTERNO. En mensajes públicos: "estaciones con convenio CMU".
- Vehículos: March Sense, March Advance, Aveo, Kwid, i10 (seminuevos con GNV instalado).
- El flujo es 100% asistido por la promotora. El taxista NO opera el sistema.
- Documentos: 14 tipos (INE frente/vuelta, CSF, licencia, tarjeta circulación, factura, concesión, etc.)
- INE = fuente de verdad para nombre. Todo documento se cruza contra el nombre de la INE.
`.trim();

export const CMU_CONV_KNOWLEDGE = `
ESTILO CONVERSACIONAL:
- Hablas español mexicano informal pero profesional. Tuteas.
- Respuestas cortas: máximo 3-4 líneas en WhatsApp.
- NUNCA uses LaTeX, fórmulas matemáticas ni símbolos de ecuación.
- NUNCA des menús numerados ("escribe 1 para..."). Conversa natural.
- Máximo 1 emoji por mensaje.
- Si no sabes algo, di "No tengo esa información, pero tu asesor CMU te puede ayudar."
- NUNCA inventes datos ni des cifras que no tengas en contexto.
- NUNCA menciones "Josué" ni "director" en mensajes a prospectos o clientes.
- NATGAS es uso interno. En mensajes a prospectos/clientes: "estaciones con convenio CMU".
`.trim();

// ─── Main completion function ────────────────────────────────────────────────

export async function claudeCompletion(
  messages: Array<{ role: string; content: string }>,
  options: { max_tokens?: number; temperature?: number; module?: "nlu" | "rag" | "conversational" } = {},
): Promise<string> {
  const { max_tokens = 500, module } = options;

  // Inject module-specific knowledge into system prompt
  const systemMsg = messages.find(m => m.role === "system");
  let systemContent = systemMsg?.content || "";

  if (module === "nlu" && !systemContent.includes("CONTEXTO OPERATIVO")) {
    systemContent = CMU_NLU_KNOWLEDGE + "\n\n" + systemContent;
  } else if (module === "rag" && !systemContent.includes("PRODUCTO CMU")) {
    systemContent = CMU_RAG_KNOWLEDGE + "\n\n" + systemContent;
  } else if (module === "conversational" && !systemContent.includes("ESTILO CONVERSACIONAL")) {
    systemContent = CMU_CONV_KNOWLEDGE + "\n\n" + systemContent;
  }

  const userMsgs = messages.filter(m => m.role !== "system");

  try {
    const client = getClient();
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens,
      system: systemContent || undefined,
      messages: userMsgs.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
    });

    return resp.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
  } catch (error: any) {
    // If Claude fails, fall back to OpenAI silently
    console.error(`[Claude] Error (${module || "general"}):`, error.message?.slice(0, 80));
    const { chatCompletion } = await import("./openai-helper");
    return chatCompletion(messages, { max_tokens, temperature: options.temperature ?? 0 });
  }
}
