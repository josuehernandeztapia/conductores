/**
 * CMU WhatsApp Agent v3 — Response Templates
 *
 * ALL responses as pure functions. No LLM calls.
 * Every state transition has a template.
 * Spanish mexicano coloquial. Respuestas cortas (3-4 líneas max). Max 1 emoji.
 */

import type { ModelSummary } from "./types";

// ─── Helper ──────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return "$" + Math.round(Math.abs(n)).toLocaleString("es-MX");
}

// ─── Templates ───────────────────────────────────────────────────────────────

export const templates = {

  // ── Greeting / Entry ──────────────────────────────────────────────────────

  greeting_prospect: (name: string) =>
    `Buenos días${name ? " " + name : ""}. Soy el asistente de *Conductores del Mundo*. Tenemos un programa para renovar tu taxi con vehículo seminuevo y kit de gas natural.\n\n¿Tu taxi ya usa *gas natural* o estás con *gasolina*?`,

  greeting_returning: (name: string, state: string) => {
    const first = name ? name.split(" ")[0] : "";
    return `Hola${first ? " " + first : ""}, qué gusto verte de vuelta. Retomamos donde nos quedamos.`;
  },

  // ── Fuel Type ─────────────────────────────────────────────────────────────

  ask_fuel_type: () =>
    `¿Tu taxi ya usa *gas natural* o estás con *gasolina*?`,

  // ── Consumo ───────────────────────────────────────────────────────────────

  ask_consumo_gnv: () =>
    `Perfecto, ya estás con gas natural. ¿Más o menos cuántos litros cargas al mes? Un aproximado está bien.`,

  ask_consumo_gasolina: () =>
    `¿Cuánto gastas de gasolina al mes, más o menos?`,

  consumo_confirm_leq: (leq: number) =>
    `Muy bien, ${leq} LEQ/mes. Déjame calcular tus opciones...`,

  consumo_confirm_pesos: (pesos: number, leq: number) =>
    `${fmt(pesos)}/mes en gasolina. Convertido a gas natural serían aprox. ${leq} LEQ/mes. Te muestro las opciones con ese consumo...`,

  consumo_out_of_range: () =>
    `Ese número no me cuadra. ¿Cuántos litros de gas cargas al mes? (entre 100 y 2,000 LEQ es lo normal)`,

  gasto_out_of_range: () =>
    `Ese monto no me cuadra. ¿Cuánto gastas de gasolina al mes en pesos? (entre $1,000 y $15,000 es lo normal para un taxi)`,

  // ── Model Listing ─────────────────────────────────────────────────────────

  show_models: (leq: number, recaudo: number, modelos: ModelSummary[]) =>
    `Con ${leq} LEQ/mes, tu recaudo GNV cubre *${fmt(recaudo)}/mes* de la cuota.\n\n*Vehículos disponibles:*\n\n${modelos.map(m =>
      `• *${m.name}* — ${fmt(m.precio)}\n  Cuota mes 3+: ${fmt(m.cuotaM3)} | Bolsillo: *${fmt(m.bolsillo)}/mes*\n  GNV cubre todo desde ${m.mesGnvLabel}`
    ).join("\n")}\n\n¿Cuál te interesa? Te doy el detalle completo.`,

  show_models_gasolina: (gastoPesos: number, modelos: ModelSummary[]) =>
    `Con tu gasto actual de ${fmt(gastoPesos)}/mes en gasolina, al pasarte a GNV tu ahorro cubriría parte de la cuota.\n\n*Vehículos disponibles:*\n\n${modelos.map(m =>
      `• *${m.name}* — ${fmt(m.precio)}\n  Cuota mes 3+: ${fmt(m.cuotaM3)} | Bolsillo: *${fmt(m.bolsillo)}/mes*\n  GNV cubre todo desde ${m.mesGnvLabel}`
    ).join("\n")}\n\n¿Cuál te interesa? Te doy el detalle completo.`,

  no_models_available: () =>
    `En este momento no tengo vehículos disponibles en el sistema. Tu asesor CMU te puede compartir el inventario actual.`,

  model_not_found: () =>
    `No encontré ese modelo. Los disponibles son: *Aveo*, *March Sense*, *March Advance*, *Kwid* y *Grand i10*.\n\n¿Cuál te interesa?`,

  // ── Tank Decision (GNV only) ──────────────────────────────────────────────

  ask_tank: (modelName: string, precio: number) =>
    `*${modelName}* — ${fmt(precio)}\n\n¿Tu tanque de GNV está en buen estado para reusarlo? Reusarlo no tiene costo extra. Equipo nuevo suma $9,400.\n\n1️⃣ *Reuso mi tanque* (sin costo)\n2️⃣ *Equipo nuevo* (+$9,400)`,

  // ── Corrida ───────────────────────────────────────────────────────────────

  show_corrida: (corridaWhatsApp: string) =>
    corridaWhatsApp + `\n\n¿Quieres empezar el proceso? Solo necesito tu nombre.`,

  // ── Registration ──────────────────────────────────────────────────────────

  ask_name: () =>
    `¿Cómo te llamas? (nombre completo)`,

  confirm_interest: () =>
    `¿Quieres empezar el proceso? Solo necesito tu nombre completo para darte de alta.`,

  name_too_short: () =>
    `Necesito tu nombre completo (nombre y apellido). ¿Cómo te llamas?`,

  // ── Folio Created ─────────────────────────────────────────────────────────

  folio_created: (nombre: string, folio: string) =>
    `Listo, ${nombre.split(" ")[0]}. Tu folio es *${folio}*.\n\nAhora vamos con tu expediente. Mándame tu *INE de frente* 📷`,

  folio_error: () =>
    `Hubo un problema al crear tu expediente. Tu asesor CMU te ayudará a resolverlo.`,

  // ── Document Capture ──────────────────────────────────────────────────────

  doc_received: (docLabel: string, count: number, total: number, nextLabel: string) =>
    `*${docLabel}* recibido. ${count}/${total}\n\nAhora mándame tu *${nextLabel}*`,

  doc_received_last: (docLabel: string, count: number, total: number) =>
    `*${docLabel}* recibido. ${count}/${total}\n\nExpediente completo. Vamos con la entrevista.`,

  doc_invalid: (docLabel: string, reason: string) =>
    `Esa imagen no parece ser *${docLabel}*. ${reason}\nIntenta de nuevo con una foto clara.`,

  doc_illegible: (docLabel: string) =>
    `No se alcanza a leer la imagen. Intenta con mejor luz o más cerca, por favor. Necesito tu *${docLabel}*.`,

  doc_wrong_type: (expectedLabel: string, detectedLabel: string) =>
    `Esa imagen parece ser *${detectedLabel}*, pero estoy esperando tu *${expectedLabel}*. Mándame la correcta, por favor.`,

  doc_cross_check_warning: (docLabel: string, flags: string[]) =>
    `*${docLabel}* recibido, pero encontré diferencias:\n${flags.map(f => `⚠️ ${f}`).join("\n")}\n\nPuedes enviarlo de nuevo o continuar.`,

  doc_progress: (collected: number, total: number, pendingLabels: string[]) =>
    `Llevas ${collected}/${total} documentos.\n\nFaltan:\n${pendingLabels.map(l => `• ${l}`).join("\n")}`,

  doc_skip_offer_interview: () =>
    `Sin problema, lo mandas cuando lo tengas.\n\n¿Quieres que hagamos la *entrevista rápida* mientras? Son 8 preguntas por nota de voz (5 min). Así avanzamos con tu evaluación.`,

  doc_all_complete: (count: number) =>
    `Expediente completo (${count} documentos).\n\nAhora hacemos una entrevista rápida: 8 preguntas por nota de voz (~5 min).\n\nEscribe *empezar* cuando estés listo.`,

  doc_ask_image: (docLabel: string) =>
    `Mándame tu *${docLabel}* 📷`,

  // ── Interview ─────────────────────────────────────────────────────────────

  interview_start: (q1Text: string) =>
    `Vamos con las preguntas. Puedes contestar con *nota de voz* o texto.\n\n*Pregunta 1 de 8:*\n${q1Text}`,

  interview_ready_prompt: () =>
    `La entrevista son 8 preguntas rápidas (~5 min). Puedes contestar con *nota de voz* o texto.\n\nEscribe *empezar* cuando estés listo.`,

  interview_complete: () =>
    `Entrevista completada. Tu evaluación está en revisión. Tu asesor(a) CMU te contactará con el resultado. 🙌`,

  interview_already_done: () =>
    `Ya completaste la entrevista. Tu evaluación está en revisión.`,

  // ── Fallback / Errors ─────────────────────────────────────────────────────

  fallback_no_understand: () =>
    `No entendí. ¿Puedes repetirlo de otra forma?`,

  fallback_state_error: () =>
    `Algo salió mal de mi lado. Intenta de nuevo en unos minutos.`,

  cold_goodbye: () =>
    `Sin problema. Cuando quieras retomar, escríbeme. El programa sigue abierto.`,

  cold_maybe_later: () =>
    `Claro, tómate tu tiempo. Cuando quieras retomar me escribes. El programa sigue abierto y las condiciones se mantienen.`,

  // ── Notifications (to team) ───────────────────────────────────────────────

  notify_new_prospect: (phone: string, name: string, fuel: string, leq: number) =>
    `🆕 *Nuevo prospecto*\nNombre: ${name || "Sin nombre"}\nTeléfono: ${phone}\nCombustible: ${fuel}\nConsumo: ${leq} LEQ/mes`,

  notify_folio_created: (folio: string, name: string, phone: string) =>
    `📋 *Folio creado*: ${folio}\nNombre: ${name}\nTeléfono: ${phone}`,

  notify_docs_complete: (folio: string, name: string) =>
    `📄 *Expediente completo*: ${folio}\nNombre: ${name}`,

  notify_interview_complete: (folio: string, name: string) =>
    `✅ *Entrevista completada*: ${folio}\nNombre: ${name}\nListo para evaluación.`,

  notify_prospect_cold: (phone: string, name: string, lastState: string) =>
    `❄️ *Prospecto frío*\n${name || phone}\nÚltimo estado: ${lastState}`,

  // ── Audio feedback ────────────────────────────────────────────────────────

  audio_processing: () =>
    `Recibí tu nota de voz, déjame procesarla...`,

  audio_error: () =>
    `No pude procesar tu nota de voz. ¿Puedes intentar de nuevo o escribir tu respuesta?`,
};

export type TemplateKey = keyof typeof templates;
