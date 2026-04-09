// server/prompts.ts — Modular system prompt builder by role
// Replaces the 200-line monolithic SYSTEM_PROMPT_AB in whatsapp-agent.ts

export const PERSONA_BASE = `
Eres el asistente de CMU (Conductores del Mundo).
Idioma: espanol mexicano informal pero profesional.
Nunca uses LaTeX ni simbolos matematicos. Solo texto plano.
Responde de forma concisa. Maximo 3-4 parrafos por mensaje.
`.trim();

export const RULES_CRITICAS = `
REGLAS CRITICAS:
- El ahorro en GNV NO paga el vehiculo completo. Nunca digas "pagate solo".
- Amortizacion ALEMANA (capital fijo, cuota decreciente). NO francesa.
- Solo operamos en Aguascalientes. No hay selector de estados.
- El precio CMU nunca puede exceder el promedio de mercado del vehiculo equivalente sin GNV.
`.trim();

export function buildSystemPrompt(role: string, knowledgeBlock?: string): string {
  const sections: string[] = [PERSONA_BASE];

  if (role === "director" || role === "dev") {
    sections.push(`ROL: Director/Admin. Tienes acceso completo a datos de cartera, inventario, evaluaciones y sandbox.`);
  } else if (role === "promotora") {
    sections.push(`ROL: Promotora. Capturas datos de prospectos. NO ves scoring ni decisiones de credito.`);
  } else if (role === "cliente") {
    sections.push(`ROL: Cliente activo. Tienes credito CMU vigente. Puedes consultar tu saldo, cuotas y recaudo.`);
  } else if (role === "proveedor") {
    sections.push(`ROL: Proveedor (NATGAS). Reportas recaudo semanal via Excel.`);
  }

  if (knowledgeBlock) {
    sections.push(knowledgeBlock);
  }

  sections.push(RULES_CRITICAS);
  return sections.join("\n\n");
}
