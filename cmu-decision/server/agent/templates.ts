/**
 * Templates v2 — Respuestas con personalidad humana
 * 
 * El agente se llama "Mau" (interno, no lo dice). Es amigable, directo,
 * habla como mexicano de Aguascalientes. Usa "tú". No es formal ni robótico.
 * Nunca dice "¡" al inicio. Usa negritas para datos importantes.
 * Emojis con moderación (1-2 por mensaje máximo).
 */

export interface ModelSummary {
  name: string;
  precio: number;
  cuotaM3: number;
  bolsillo: number;
  mesGnvLabel: string;
}

// ═══════════════════════════════════════════════════════════════
// PASO 1: Saludo + pedir nombre
// ═══════════════════════════════════════════════════════════════

export function greeting(profileName: string): string {
  const hour = new Date().getHours();
  const saludo = hour < 12 ? "Buenos días" : hour < 18 ? "Buenas tardes" : "Buenas noches";
  const name = profileName ? ` ${profileName}` : "";
  return `${saludo}${name}. Soy el asistente de *Conductores del Mundo*, un programa de renovación de taxis aquí en Aguascalientes.\n\nAntes de platicarte de qué se trata, ¿cómo te llamas?`;
}

// ═══════════════════════════════════════════════════════════════
// PASO 2: Contexto del programa + pregunta combustible
// ═══════════════════════════════════════════════════════════════

export function program_context(nombre: string): string {
  const firstName = nombre.split(" ")[0];
  return `Mucho gusto, ${firstName}. Te platico rápido:\n\n*Conductores del Mundo (CMU)* es un programa para taxistas. Te damos un vehículo seminuevo con kit de gas natural instalado, y *gran parte del pago mensual se cubre con lo que ya gastas en combustible*.\n\n• Sin buró de crédito\n• Sin aval\n• Registro gratuito\n• 36 meses y el vehículo es tuyo\n\nPara darte los números exactos de cuánto pagarías: ¿tu taxi ya usa *gas natural* o estás con *gasolina*?`;
}

// ═══════════════════════════════════════════════════════════════
// PASO 3: Pedir consumo
// ═══════════════════════════════════════════════════════════════

export function ask_consumo_gnv(firstName: string): string {
  return `Perfecto, ${firstName}, ya estás con gas natural. ¿Más o menos cuántos litros cargas al mes? Un aproximado está bien, no tiene que ser exacto.`;
}

export function ask_consumo_gasolina(firstName: string): string {
  return `¿Cuánto gastas de gasolina al mes, más o menos? Con eso te calculo cuánto ahorrarías con gas natural.`;
}

export function consumo_out_of_range(): string {
  return `Hmm, ese número no me cuadra. Un taxi normalmente consume entre 200 y 800 litros al mes. ¿Cuánto dirías que cargas?`;
}

export function gasto_out_of_range(): string {
  return `Ese monto no me cuadra mucho. Un taxi normalmente gasta entre $2,000 y $15,000 al mes en gasolina. ¿Más o menos cuánto gastas?`;
}

// ═══════════════════════════════════════════════════════════════
// PASO 4: Mostrar modelos
// ═══════════════════════════════════════════════════════════════

export function show_models(firstName: string, leq: number, recaudo: number, modelos: ModelSummary[]): string {
  const lines = modelos.map(m =>
    `• *${m.name}* — $${m.precio.toLocaleString()}\n  Cuota mes 3+: $${m.cuotaM3.toLocaleString()} | De tu bolsillo: *$${m.bolsillo.toLocaleString()}/mes*\n  ${m.mesGnvLabel}`
  ).join("\n");

  return `${firstName}, con tu consumo de ${leq} LEQ/mes, tu recaudo de GNV cubriría *$${recaudo.toLocaleString()}/mes* de la cuota.\n\nEstos son los vehículos que tenemos disponibles:\n\n${lines}\n\n¿Cuál te llama la atención? Te doy los números completos.`;
}

export function no_models_available(): string {
  return `Ahorita no tenemos vehículos disponibles, pero estamos por recibir unidades. Déjame tus datos y te aviso en cuanto haya inventario.`;
}

// ═══════════════════════════════════════════════════════════════
// PASO 5: Tanque GNV (solo Perfil A)
// ═══════════════════════════════════════════════════════════════

export function ask_tank(modelName: string, precio: number): string {
  return `*${modelName}* — $${precio.toLocaleString()}\n\nUna pregunta: ¿tu tanque de GNV está en buen estado? Si lo podemos reusar, no tiene costo extra. Si prefieres equipo nuevo, se suman $9,400 al precio.\n\n1️⃣ *Reuso mi tanque* (sin costo)\n2️⃣ *Equipo nuevo* (+$9,400)`;
}

// ═══════════════════════════════════════════════════════════════
// PASO 6: Corrida detallada + explicar el proceso
// ═══════════════════════════════════════════════════════════════

export function show_corrida(corridaResumen: string, kitLabel: string, firstName: string): string {
  return `${corridaResumen}\n${kitLabel}\n\n${firstName}, si te interesa avanzar, el proceso es así:\n\n*1.* Me mandas *14 documentos* por foto (te voy guiando uno por uno)\n*2.* Hacemos una *entrevista rápida* de 8 preguntas por nota de voz (~5 min)\n*3.* Revisamos tu expediente y te damos respuesta\n\nLos docs y la entrevista los puedes hacer en el orden que quieras, no tiene que ser todo hoy.\n\n¿Le entramos?`;
}

// ═══════════════════════════════════════════════════════════════
// PASO 7: Confirma que quiere empezar → crear folio
// ═══════════════════════════════════════════════════════════════

export function folio_created(firstName: string, folio: string): string {
  return `Listo, ${firstName}. Tu folio es *${folio}*.

Para armar tu expediente necesito 14 documentos + una entrevista de 8 preguntas. *No tiene que ser todo hoy* — mándame lo que tengas a la mano y los demás cuando puedas.

Te voy guiando uno por uno:
• Si no tienes alguno, escribe *siguiente*
• Si quieres ver cuáles son, escribe *documentos*
• Si prefieres empezar con la entrevista, escribe *entrevista*
• Pregúntame lo que quieras en cualquier momento

¿Traes tu *INE*? Mándame foto del frente 📷`;
}

// ═══════════════════════════════════════════════════════════════
// DOCUMENTOS
// ═══════════════════════════════════════════════════════════════

export function doc_received(docLabel: string, count: number, total: number, nextLabel: string): string {
  return `*${docLabel}* recibido ✓ (${count}/${total})\n\n¿Tienes tu *${nextLabel}* a la mano? Mándamelo 📷\n_Si no lo tienes ahorita, escribe *siguiente* o *ya no tengo más*._`;
}

export function doc_all_complete(firstName: string): string {
  return `${firstName}, ya tengo todos tus documentos ✓\n\n¿Ya hiciste la entrevista? Si no, escribe *entrevista* para empezarla. Si ya la hiciste, tu expediente está completo y en revisión.`;
}

export function doc_invalid(expectedLabel: string, reason: string): string {
  return `Esa imagen no parece ser *${expectedLabel}*. ${reason}\n\nIntenta de nuevo con una foto más clara, o escribe *siguiente* para saltarlo por ahora.`;
}

export function doc_skipped(skippedLabel: string, nextLabel: string, pendingCount: number): string {
  return `Ok, dejamos *${skippedLabel}* para después.\n\n¿Tienes tu *${nextLabel}*? 📷\n_O escribe *ya no tengo más* si quieres dejarlo por hoy._`;
}

export function doc_status(firstName: string, completed: number, total: number, pendingList: string[], interviewDone: boolean): string {
  const docLine = completed === total
    ? `Documentos: *${completed}/${total}* ✓ completo`
    : `Documentos: *${completed}/${total}* — Faltan: ${pendingList.join(", ")}`;
  
  const interviewLine = interviewDone
    ? `Entrevista: *Completada* ✓`
    : `Entrevista: *Pendiente* — escribe "entrevista" para empezarla`;

  const allDone = completed === total && interviewDone;
  const statusLine = allDone
    ? `\nTu expediente está *completo* y en revisión. Te avisamos pronto.`
    : `\nMándame lo que tengas o pregúntame lo que quieras.`;

  return `${firstName}, así va tu proceso:\n\n${docLine}\n${interviewLine}${statusLine}`;
}

// ═══════════════════════════════════════════════════════════════
// ENTREVISTA
// ═══════════════════════════════════════════════════════════════

export function interview_intro(): string {
  return `Son 8 preguntas rápidas sobre tu operación como taxista (~5 min). Puedes contestar con *nota de voz* o texto.\n\nEscribe *empezar* cuando estés listo.`;
}

export function interview_question(qNum: number, total: number, questionText: string): string {
  return `*Pregunta ${qNum} de ${total}:*\n${questionText}`;
}

export function interview_understood(extractedData: string): string {
  return `_${extractedData}_`;
}

export function interview_complete(firstName: string, hasPendingDocs: boolean, pendingCount?: number): string {
  if (hasPendingDocs) {
    return `Entrevista completada ✓\n\n${firstName}, te faltan *${pendingCount} documentos*. Mándamelos cuando puedas. Escribe *estado* para ver cuáles son.\n\nCuando esté todo completo, revisamos tu expediente y te damos respuesta.`;
  }
  return `Entrevista completada ✓\n\nTu expediente está *completo*, ${firstName}. Lo revisamos y te damos respuesta pronto. Gracias por tu tiempo.`;
}

// ═══════════════════════════════════════════════════════════════
// FALLBACKS
// ═══════════════════════════════════════════════════════════════

export function fallback_no_understand(): string {
  return `No entendí esa. ¿Puedes repetirlo de otra forma?`;
}

export function fallback_state_error(): string {
  return `Tuve un problema técnico. Intenta de nuevo o escríbenos al 446 329 3102.`;
}

export function cold_goodbye(firstName: string): string {
  return `Sin problema, ${firstName}. Cuando quieras retomar, escríbeme. El programa sigue abierto.`;
}

export function already_complete(): string {
  return `Tu expediente ya está en revisión. Te avisamos pronto con el resultado. Si tienes alguna duda, pregúntame.`;
}

// ═══════════════════════════════════════════════════════════════
// EXPLICACIONES DE DOCUMENTOS (uno por uno, con contexto humano)
// ═══════════════════════════════════════════════════════════════

export const DOC_EXPLANATIONS: Record<string, string> = {
  ine_frente: "Tu *INE de frente* — el lado donde está tu foto y nombre. Una foto derecha donde se lean bien los datos.",
  ine_reverso: "Ahora el *reverso de tu INE* — el lado sin foto, donde está el código de barras (MRZ) y el QR.",
  tarjeta_circulacion: "Tu *tarjeta de circulación* — la de tu unidad actual.",
  factura_vehiculo: "La *factura de tu vehículo actual* — si no la tienes a la mano, escribe *siguiente* y la mandas después.",
  csf: "Tu *Constancia de Situación Fiscal* (CSF) — la sacas en el portal del SAT o tu contador te la da. Debe tener máximo 30 días.",
  comprobante_domicilio: "Un *comprobante de domicilio* reciente — recibo de luz (CFE), agua, teléfono o banco. Máximo 3 meses. Puede estar a nombre de tu esposa o familiar, lo importante es que la *dirección coincida con tu INE*.",
  concesion: "Tu *concesión de taxi vigente* — el documento que te autoriza a operar como taxi en Aguascalientes.",
  estado_cuenta: "Tu *estado de cuenta bancario (carátula)* — donde se vea tu nombre, CLABE a 18 dígitos, y dirección. La dirección debe coincidir con tu INE.",
  historial_gnv: "Tu *historial de consumo GNV* — necesito 3 o 4 comprobantes recientes de carga de gas. Puede ser el ticket físico o captura de pantalla del historial. Si los tienes en el tablero del carro, con una foto está bien.",
  tickets_gasolina: "Tus *tickets de gasolina* — 3 o 4 recientes. Pueden ser de Magna o Premium.",
  carta_membresia: "Tu *Carta de Membresía Gremial* — la carta de tu agrupación de taxis (ACATAXI, CTM, etc.) que confirma que eres miembro activo.",
  selfie_biometrico: "Una *selfie tuya sosteniendo tu INE* — tómala con buena luz, que se vea tu cara y la INE legible.",
  ine_operador: "La *INE del operador* — si alguien más maneja tu taxi, necesito la credencial de esa persona. Si no tienes operador, escribe *siguiente*.",
  licencia_conducir: "La *licencia de conducir del operador* — vigente. Si no tienes operador, escribe *siguiente*.",
  fotos_unidad: "*Fotos de tu unidad* — necesito 4 fotos: frente, trasera, lateral izquierdo y lateral derecho. De preferencia que se vea la placa.",
};

export const DOC_FAQ: Record<string, Record<string, string>> = {
  historial_gnv: {
    'cuantos': 'Mándame 3 o 4 tickets recientes de carga de GNV. Los del último mes están bien.',
    'donde': 'El ticket de carga o comprobante de la estación donde cargas GNV. Si los tienes en el tablero del carro, con foto está bien.',
  },
  tickets_gasolina: {
    'cuantos': 'Mándame 3 o 4 tickets recientes de gasolina.',
  },
  fotos_unidad: {
    'cuantas': 'Necesito 4 fotos: frente, trasera, lateral izquierdo y lateral derecho.',
  },
};

export function doc_explanation(docKey: string): string {
  return DOC_EXPLANATIONS[docKey] || `Tu *${docKey}*`;
}

export function doc_request_with_explanation(docKey: string, docLabel: string, count: number, total: number): string {
  const explanation = DOC_EXPLANATIONS[docKey] || `Tu *${docLabel}*`;
  return `${explanation} 📷\n\n_(${count}/${total}) Si no lo tienes, escribe *siguiente*_`;
}

// ═══════════════════════════════════════════════════════════════
// RETOMAR CONVERSACIÓN (cuando vuelve después de un rato)
// ═══════════════════════════════════════════════════════════════

export function welcome_back(firstName: string, pendingDocLabel: string | null, interviewDone: boolean, docsCompleted: number, docsTotal: number): string {
  let msg = `Hola de nuevo, ${firstName}.`;
  
  if (pendingDocLabel) {
    msg += ` La última vez nos quedamos en tu *${pendingDocLabel}*. ¿La tienes? Si no, escribe *siguiente* y pasamos al que sigue.`;
  } else if (!interviewDone) {
    msg += ` Tienes ${docsCompleted}/${docsTotal} documentos. ¿Quieres seguir con los docs o prefieres hacer la *entrevista* primero?`;
  } else if (docsCompleted < docsTotal) {
    msg += ` Te faltan ${docsTotal - docsCompleted} documentos. Mándame el que tengas o escribe *estado* para ver cuáles faltan.`;
  } else {
    msg += ` Tu expediente está completo y en revisión. Te avisamos pronto.`;
  }
  
  msg += `\n\n_Si prefieres que alguien te ayude en persona, dime y te conecto con nuestro promotor._`;
  return msg;
}

// ═══════════════════════════════════════════════════════════════
// CIERRE DE SESIÓN NATURAL
// ═══════════════════════════════════════════════════════════════

export function session_close(firstName: string, docsCompleted: number, docsTotal: number, interviewDone: boolean): string {
  const pending = docsTotal - docsCompleted;
  let msg = `Perfecto ${firstName}, con lo que me diste hoy ya arrancamos.`;
  if (docsCompleted > 0) {
    msg += ` Llevas *${docsCompleted}/${docsTotal}* documentos.`;
  }
  if (pending > 0) {
    msg += `\n\nCuando tengas más documentos, mándamelos aquí — yo los proceso al instante.`;
  }
  if (!interviewDone) {
    msg += ` También puedes hacer la entrevista de 8 preguntas cuando quieras (escribe *entrevista*).`;
  }
  msg += `\n\nTe escribo pronto para ver cómo vas. 👍`;
  return msg;
}

// ═══════════════════════════════════════════════════════════════
// ASISTENCIA PROMOTOR
// ═══════════════════════════════════════════════════════════════

export function offer_promotor_help(firstName: string): string {
  return `${firstName}, si prefieres hacer el trámite en persona, nuestro promotor te puede asistir con la captura de documentos y resolver cualquier duda. ¿Quieres que te contacte?`;
}

export function promotor_notified(firstName: string): string {
  return `Listo, ${firstName}. El promotor va a contactarte para ayudarte. Mientras tanto, si quieres avanzar por aquí, mándame lo que tengas.`;
}
