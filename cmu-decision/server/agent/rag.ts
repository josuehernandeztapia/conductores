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
import { claudeCompletion } from "./claude-helper";
import { buildClientKnowledge } from "../cmu-knowledge";
import { getBusinessRules } from "../business-rules";


// ─── Pre-Written FAQ ─────────────────────────────────────────────────────────

interface FAQEntry {
  patterns: RegExp[];
  answer: string;
}

const FAQ: FAQEntry[] = [
  // ═══════════════════════════════════════
  // PROGRAMA — Qué es CMU
  // ═══════════════════════════════════════
  {
    patterns: [/qu[eé]\s+(?:es|hace)\s+cmu/i, /c[oó]mo\s+funciona\s+(?:el\s+)?programa/i, /en\s+qu[eé]\s+consiste/i, /expl[ií]came/i],
    answer: "CMU (Conductores del Mundo) te ofrece un taxi seminuevo con kit de gas natural incluido. Pagas una cuota mensual que baja cada mes (amortización alemana). El recaudo por GNV en estaciones con convenio CMU cubre parte o toda tu cuota. En 36 meses el vehículo es tuyo.",
  },
  {
    patterns: [/proceso\s+completo/i, /paso\s+a\s+paso/i, /c[oó]mo\s+(?:es|funciona)\s+el\s+(?:tr[aá]mite|flujo)/i, /punta\s+a\s+punta/i],
    answer: "El proceso completo es: 1) Registro por WhatsApp con tu nombre y datos. 2) Captura de 14 documentos (por foto aquí). 3) Entrevista rápida por WhatsApp. 4) Selección de vehículo. 5) Firma digital del contrato. 6) Entrega del vehículo con kit GNV instalado. Todo tarda aproximadamente 2 semanas.",
  },
  {
    patterns: [/cu[aá]nto\s+tarda/i, /tiempo.*tr[aá]mite/i, /cu[aá]ndo.*(?:me|lo).*(?:dan|entrega)/i, /en\s+cu[aá]nto\s+tiempo/i],
    answer: "El trámite completo tarda aproximadamente 2 semanas: captura de documentos (3-5 días), entrevista (1 día), revisión y aprobación (3-5 días), firma y entrega. Depende de qué tan rápido mandes tus documentos.",
  },

  // ═══════════════════════════════════════
  // CUOTAS Y PAGOS
  // ═══════════════════════════════════════
  {
    patterns: [/cuota/i, /cu[aá]nto\s+(?:voy\s+a\s+)?pag(?:o|ar)/i, /mensualidad/i, /amortizaci[oó]n/i],
    answer: "Las cuotas son decrecientes (amortización alemana): capital fijo + interés sobre saldo. Mes 1 es la cuota más alta, mes 36 la más baja. El recaudo GNV cubre una parte — mientras más cargas gas, menos pagas de tu bolsillo. Dime tu gasto mensual en combustible y te calculo.",
  },
  {
    patterns: [/plazo/i, /cu[aá]ntos\s+meses/i, /36\s+meses/i, /cu[aá]ndo.*m[ií]o/i, /en\s+cu[aá]nto.*(?:a[ñn]os|meses)/i],
    answer: "El programa es a 36 meses con cuota decreciente. Al terminar y liquidar, el vehículo se transfiere a tu nombre. Es 100% tuyo.",
  },
  {
    patterns: [/donde.*pag/i, /c[oó]mo.*pag/i, /clabe/i, /oxxo/i, /conekta/i, /transferencia/i, /m[eé]todo.*pago/i],
    answer: "Puedes pagar por liga de pago (SPEI, OXXO, 7-Eleven) o directo a la CLABE 152680120000787681 (Bancrea) con tu folio de referencia. La liga te llega por WhatsApp cada mes.",
  },
  {
    patterns: [/adelantar.*pago/i, /abonar.*m[aá]s/i, /pagar.*extra/i, /abono.*capital/i],
    answer: "Sí, puedes adelantar pagos o abonar de más en cualquier momento. Todo se abona a capital y reduce tu saldo. Sin penalización.",
  },
  {
    patterns: [/liquidar.*antes/i, /pagar.*todo/i, /anticip.*liquidar/i, /saldo.*insoluto/i, /liquidaci[oó]n/i],
    answer: "Sí, puedes liquidar el saldo en cualquier momento sin penalización. Contacta a CMU para obtener tu saldo de liquidación y al pagar se te transfiere el vehículo.",
  },

  // ═══════════════════════════════════════
  // ENGANCHE Y ANTICIPO
  // ═══════════════════════════════════════
  {
    patterns: [/enganche|anticipo|apartado|desembolso.*inicial/i, /cu[aá]nto.*dar.*inicio/i, /dinero.*inicial/i],
    answer: "No hay anticipo ni enganche inicial. En el día 56 (mes 2) vendes tu taxi actual y esos $50,000 se abonan a capital, lo que reduce tu cuota mensual del mes 3 en adelante.",
  },
  {
    patterns: [/m[aá]s\s+de\s+50/i, /dar\s+m[aá]s/i, /anticipo\s+mayor/i],
    answer: "Sí, puedes dar más de $50,000 de anticipo. Todo se abona a capital y tu cuota baja más. El mínimo es $50,000 pero no hay tope.",
  },
  {
    patterns: [/vender.*taxi/i, /d[ií]a\s*56/i, /mi\s+taxi\s+actual/i, /entregar.*taxi/i, /dar.*(?:mi|el)\s+taxi/i],
    answer: "En el día 56 vendes tu taxi actual. Los $50,000 se abonan a capital para reducir tu cuota del mes 3 en adelante. CMU no te lo compra — tú lo vendes por tu cuenta. Si necesitas más tiempo, comunícate antes del día 56 para una prórroga.",
  },
  {
    patterns: [/56\s*d[ií]as/i, /no\s+vend/i, /m[aá]s\s+tiempo/i, /extender.*plazo/i, /pr[oó]rroga/i],
    answer: "Si necesitas más tiempo para vender tu taxi, habla con CMU antes del día 56. Se puede extender sin penalización. Lo importante es comunicarte, no desaparecer.",
  },
  {
    patterns: [/no\s+tengo\s+(?:taxi|carro|veh[ií]culo)/i, /sin\s+taxi/i, /taxi.*(?:prestado|rentado)/i],
    answer: "Necesitas concesión vigente en Aguascalientes, pero el taxi puede ser prestado o rentado. Lo importante es la concesión a tu nombre.",
  },

  // ═══════════════════════════════════════
  // FONDO DE GARANTÍA Y MORA
  // ═══════════════════════════════════════
  {
    patterns: [/fondo\s*de\s*garant[ií]a/i, /\bfg\b/i],
    answer: "El Fondo de Garantía (FG) son $8,000 iniciales + $334/mes, tope $20,000. Es un seguro: cubre si no puedes trabajar o hay siniestro. Si llegas al mes 37 sin usarlo, se te devuelve completo.",
  },
  {
    patterns: [/mora/i, /(?:no|si\s+no)\s+pag(?:o|ar)/i, /(?:qu[eé]\s+pasa\s+si|y\s+si)\s+no\s+pag/i, /atraso/i, /atras/i],
    answer: "Si tu recaudo GNV no cubre la cuota, tienes 5 días para pagar el diferencial. Si no, el Fondo de Garantía cubre automáticamente. Si el FG se agota, hay recargo de $250 + 2% mensual. Tres meses sin regularizar = rescisión.",
  },

  // ═══════════════════════════════════════
  // REQUISITOS Y DOCUMENTOS
  // ═══════════════════════════════════════
  {
    patterns: [/requisitos/i, /qu[eé]\s+necesito/i, /qu[eé]\s+(?:me\s+)?pid(?:en|es)/i, /qu[eé]\s+(?:documentos|papeles)/i, /checklist/i],
    answer: "Requisitos (14 documentos + entrevista + firma):\n\n*Documentos con vigencia:*\n1. INE vigente (frente y reverso)\n2. Comprobante de domicilio (max 3 meses)\n3. Constancia de Situación Fiscal SAT (max 3 meses)\n4. Estado de cuenta bancario (max 3 meses)\n5. Concesión de taxi vigente\n\n*Documentos sin vigencia:*\n6. Tarjeta de circulación\n7. Factura del taxi actual\n8. CURP\n9. Acta de nacimiento\n10. Carta de agrupación/gremial\n11. Historial de cargas (tickets gas o gasolina)\n12. Comprobante de ingresos\n13. Selfie con tu INE\n14. Fotos de tu unidad (4 fotos)\n\nDespués: entrevista por WhatsApp (10 min) + firma digital del contrato.\nTodo se manda por foto aquí. Si no tienes alguno, escribe *saltar*.",
  },
  {
    patterns: [/concesi[oó]n/i, /vigente/i, /no\s+tengo\s+concesi/i, /concesi[oó]n.*vencid/i],
    answer: "Necesitas ser titular de una concesión de taxi vigente en Aguascalientes. Si está vencida, necesitas renovarla primero. Si la concesión está a nombre de otra persona, el titular es quien debe solicitar.",
  },
  {
    patterns: [/entrevista/i, /cu[aá]ndo.*entrevista/i, /qu[eé].*preguntan/i],
    answer: "La entrevista se hace por WhatsApp después de completar los 14 documentos. Son 8 preguntas sobre tu experiencia como taxista, situación financiera y motivación. Dura unos 10 minutos.",
  },
  {
    patterns: [/firma/i, /contrato/i, /cu[aá]ndo\s+se\s+firma/i, /c[oó]mo\s+(?:se\s+)?firma/i],
    answer: "El contrato se firma digitalmente por WhatsApp (Mifiel) o de forma presencial con el promotor. Se genera después de completar documentos + entrevista + aprobación. Incluye compraventa y pagaré.",
  },

  // ═══════════════════════════════════════
  // VEHÍCULO
  // ═══════════════════════════════════════
  {
    patterns: [/(?:son|es)\s+nuev[oa]s?/i, /(?:son|es)\s+usad[oa]s?/i, /seminuev/i, /estado.*(?:carro|veh[ií]culo)/i, /condici[oó]n/i],
    answer: "Son vehículos seminuevos (2020-2024), reconstruidos por CMU con garantía. Se les instala kit GNV nuevo. Están revisados y listos para operar como taxi.",
  },
  {
    patterns: [/color/i, /de\s+qu[eé]\s+color/i, /elegir.*color/i, /blanco/i],
    answer: "Todos los vehículos son blancos — es el color reglamentario para taxi en Aguascalientes.",
  },
  {
    patterns: [/a\s+nombre\s+de\s+qui[eé]n/i, /de\s+qui[eé]n.*carro/i, /reserva.*dominio/i, /propietario/i],
    answer: "El vehículo queda a nombre de CMU hasta que pagues la última cuota (mes 36). Tú lo usas, lo aseguras y lo operas. Al liquidar, CMU te transfiere el dominio y es 100% tuyo.",
  },
  {
    patterns: [/qu[eé]\s+incluye/i, /viene.*(?:incluid|equip)/i, /trae.*(?:el\s+carro|el\s+veh[ií]culo)/i],
    answer: "El programa incluye: vehículo seminuevo reconstruido + kit GNV con instalación + garantía mecánica CMU. No incluye seguro vehicular (es responsabilidad del taxista) ni mantenimiento rutinario.",
  },
  {
    patterns: [/autom[aá]tico/i, /est[aá]ndar/i, /transmisi[oó]n/i, /manual/i],
    answer: "Depende del modelo. El Vento tiene transmisión automática. March, Aveo, Kwid e i10 son estándar (manual). Pregunta por el modelo que te interese.",
  },

  // ═══════════════════════════════════════
  // KIT GNV Y GAS
  // ═══════════════════════════════════════
  {
    patterns: [/kit\s*(?:de\s*)?(?:gnv|gas)/i, /equipo\s*(?:de\s*)?gas/i, /instalaci[oó]n\s*(?:de\s*)?gas/i, /(?:va|viene)\s+incluid/i, /kit.*incluid/i],
    answer: "El kit de gas natural viene incluido en el precio del vehículo. Incluye equipo completo con tanque. Si ya tienes tanque en buen estado, puedes reusarlo y se descuenta del costo.",
  },
  {
    patterns: [/no\s+tengo\s+gas/i, /no\s+(?:uso|tengo).*gnv/i, /pura\s+gasolina/i, /solo.*gasolina/i, /nunca.*(?:he\s+)?(?:cargado|usado)\s+gas/i],
    answer: "No importa si nunca has usado gas. El vehículo viene con kit GNV instalado y listo. Desde el día 1 empiezas a cargar en estaciones con convenio CMU. El carro es bicombustible — también funciona con gasolina.",
  },
  {
    patterns: [/d[oó]nde\s+carg(?:o|ar)\s+gas/i, /estaci[oó]n|estaciones/i, /gasolinera.*gas/i, /eds/i],
    answer: "Cargas en estaciones con convenio CMU en Aguascalientes. El recaudo se registra automáticamente con tu placa.",
  },
  {
    patterns: [/cu[aá]nto\s+cuesta.*gas/i, /precio.*(?:gas|gnv|leq)/i, /litro.*gas/i],
    answer: "El precio del GNV es variable — consulta en la estación con convenio CMU. El ahorro vs gasolina ronda entre 40-50% dependiendo del consumo.",
  },
  {
    patterns: [/(?:se\s+acab|qued).*(?:gas|sin\s+gas)/i, /bicombust/i, /bifuel/i, /tambi[eé]n.*gasolina/i],
    answer: "El carro es bicombustible (bifuel). Si se acaba el gas, cambia automáticamente a gasolina. Puedes cargar en cualquier gasolinera normal.",
  },
  {
    patterns: [/tanque.*seguro/i, /peligro.*gas/i, /explosi[oó]n/i, /riesgo.*tanque/i],
    answer: "Sí, el tanque es seguro. Tiene certificación NOM y pasa revisión periódica. El GNV es más seguro que la gasolina — se disipa en el aire en caso de fuga.",
  },
  {
    patterns: [/ahorro/i, /cu[aá]nto\s+(?:me\s+)?ahorro/i, /(?:conviene|sale).*gas/i],
    answer: "El ahorro por usar gas natural vs gasolina ronda entre 40-50%. Ejemplo: si gastas $7,000/mes en gasolina, con GNV gastarías ~$3,500-4,200. Esa diferencia cubre gran parte de tu cuota mensual.",
  },

  // ═══════════════════════════════════════
  // ELEGIBILIDAD
  // ═══════════════════════════════════════
  {
    patterns: [/aval/i, /fiador/i, /garant[ií]a\s+personal/i, /obligado\s+solidario/i],
    answer: "No se necesita aval ni fiador. CMU no pide garantías personales. Solo tu concesión vigente y tus documentos.",
  },
  {
    patterns: [/bur[oó]/i, /historial\s+credit/i, /checan.*bur/i, /revisan.*bur/i],
    answer: "No revisamos buró de crédito. CMU es venta a plazos, no crédito bancario. Evaluamos tu operación como taxista y tu consumo de combustible.",
  },
  {
    patterns: [/aguascalientes/i, /qu[eé]\s+(?:ciudad|estado|zona)/i, /d[oó]nde\s+(?:es|est[aá]n|operan)/i, /otra\s+ciudad/i, /fuera\s+de/i],
    answer: "CMU opera solo en Aguascalientes. Necesitas concesión de taxi vigente en AGS. No se puede usar el vehículo en otra ciudad — es concesión local.",
  },

  // ═══════════════════════════════════════
  // SEGURO, GARANTÍA Y MANTENIMIENTO
  // ═══════════════════════════════════════
  {
    patterns: [/seguro/i, /asegurar/i, /p[oó]liza/i, /qui[eé]n.*paga.*seguro/i],
    answer: "El seguro vehicular es responsabilidad del taxista durante los 36 meses. Tú eliges la aseguradora. Es obligatorio mantenerlo vigente.",
  },
  {
    patterns: [/siniestro/i, /choque/i, /accidente.*carro/i],
    answer: "En caso de siniestro, tu seguro cubre la unidad. Reporta a tu aseguradora y notifica a CMU.",
  },
  {
    patterns: [/garant[ií]a.*mec[aá]nic/i, /(?:se\s+)?descompon/i, /falla.*mec[aá]nic/i, /garant[ií]a.*(?:carro|veh[ií]culo)/i],
    answer: "CMU ofrece garantía mecánica por defectos de reconstrucción (90 días). El mantenimiento rutinario (aceite, frenos, llantas) es responsabilidad del taxista.",
  },
  {
    patterns: [/mantenimiento/i, /servicio.*mec[aá]nico/i, /aceite|frenos|llantas/i],
    answer: "El mantenimiento rutinario es responsabilidad del taxista. CMU no incluye servicio mecánico.",
  },

  // ═══════════════════════════════════════
  // MISCELÁNEAS
  // ═══════════════════════════════════════
  {
    patterns: [/uber|didi|plataforma|app/i],
    answer: "No, el vehículo es para operar como taxi con concesión. No se puede usar en plataformas como Uber o DiDi.",
  },
  {
    patterns: [/cancelar/i, /arrepent/i, /ya\s+no\s+quiero/i, /devolver/i],
    answer: "Antes de la firma del contrato: puedes cancelar sin costo. Después de la firma: aplican las cláusulas del contrato de compraventa. Comunícate con CMU para explorar opciones.",
  },
  {
    patterns: [/promotor/i, /asesor/i, /en\s+persona/i, /oficina/i, /presencial/i, /con[eé]ctame/i],
    answer: "Si prefieres ayuda en persona, nuestro promotor puede asistirte con los documentos y resolver tus dudas. Solo dime y te lo conecto.",
  },
  {
    patterns: [/refinanciar/i, /reestructur/i, /cambiar.*(?:plazo|cuota)/i],
    answer: "Si necesitas reestructurar tu plan, contacta al director de CMU. Se evalúa caso por caso dependiendo de tu historial de pagos.",
  },
  {
    patterns: [/otro\s+chofer/i, /poner\s+(?:otro\s+)?chofer/i, /(?:alguien|otro).*manej/i],
    answer: "Puedes designar un operador adicional, pero el titular del contrato sigues siendo tú. El chofer autorizado se registra en el sistema.",
  },

  // ═══════════════════════════════════════
  // CONFIANZA / LEGITIMIDAD
  // ═══════════════════════════════════════
  {
    patterns: [/estafa/i, /fraude/i, /es\s+real/i, /es\s+confiable/i, /es\s+seguro/i, /es\s+verdad/i, /me\s+van\s+a\s+robar/i],
    answer: "CMU (Conductores del Mundo) es una empresa registrada que opera en Aguascalientes. Trabajamos con contratos legales firmados digitalmente, pagos por liga bancaria (SPEI/OXXO), y el vehículo tiene factura a nombre de CMU hasta que termines de pagar. Si tienes dudas, pide hablar con nuestro promotor en persona.",
  },
  {
    patterns: [/qui[eé]n\s+(?:es|son)\s+(?:ustedes|cmu)/i, /qu[eé]\s+empresa/i, /d[oó]nde\s+est[aá]n.*oficina/i, /tienen\s+oficina/i],
    answer: "CMU (Conductores del Mundo) es una empresa de financiamiento vehicular para taxistas en Aguascalientes. Operamos con contratos formales y pagos bancarios.",
  },
  {
    patterns: [/(?:hay|conoce).*taxista.*(?:ya|que)/i, /alguien.*(?:ya|que).*(?:tiene|hizo|entr[oó])/i, /testimonio/i, /referencia/i],
    answer: "Sí, ya hay taxistas operando con vehículos CMU en Aguascalientes. Si quieres, te podemos conectar con alguno para que te platique su experiencia.",
  },
  {
    patterns: [/es\s+legal/i, /registrad[oa]/i, /est[aá]n.*(?:constituidos|dados\s+de\s+alta)/i],
    answer: "Sí, CMU está legalmente constituida y opera con contratos de compraventa y pagarés firmados ante testigos. Todo es formal y legal.",
  },

  // ═══════════════════════════════════════
  // TECNOLOGÍA / AYUDA BÁSICA
  // ═══════════════════════════════════════
  {
    patterns: [/(?:no\s+s[eé]|c[oó]mo).*(?:mand|envi).*foto/i, /(?:no\s+s[eé]|c[oó]mo).*(?:tom|sac).*foto/i, /no\s+(?:le\s+)?(?:s[eé]|entiendo)/i],
    answer: "No te preocupes. Para mandar una foto: abre la cámara de tu celular, toma la foto del documento sobre una mesa con buena luz, y aquí en el chat dale al clip (📎) y selecciona la foto. Si necesitas ayuda, dime 'promotor' y te conecto con alguien que te guíe.",
  },
  {
    patterns: [/eres\s+robot/i, /eres\s+persona/i, /eres\s+(?:una\s+)?m[aá]quina/i, /qui[eé]n.*(?:escribe|habla|eres)/i, /con\s+qui[eé]n\s+hablo/i],
    answer: "Soy el asistente de CMU por WhatsApp. Te ayudo con información del programa, documentos y trámites. Si prefieres hablar con una persona, escribe 'promotor' y te conecto.",
  },
  {
    patterns: [/no\s+tengo.*(?:internet|datos|wifi)/i, /se\s+me\s+acab.*datos/i, /celular.*(?:viejo|malo|lento)/i],
    answer: "Tranquilo, el trámite es por WhatsApp a tu ritmo. Si se te acaban los datos, puedes continuar cuando tengas conexión — tu avance se guarda automáticamente. Si tu celular es muy viejito, tu promotor puede ayudarte en persona.",
  },
  {
    patterns: [/(?:no\s+)?entend[ií]/i, /repite/i, /otra\s+vez/i, /expl[ií]ca.*(?:otra|de\s+nuevo|m[aá]s)/i, /m[aá]s\s+(?:despacio|sencillo|simple|claro)/i],
    answer: "Claro, con gusto te lo explico de nuevo. Dime qué parte no te quedó clara y te la explico más sencillo. O si prefieres, escribe 'promotor' y te atendemos en persona.",
  },
  {
    patterns: [/(?:puedo|prefiero)\s+(?:llamar|hablar\s+por\s+tel[eé]fono)/i, /tienen\s+tel[eé]fono/i, /n[uú]mero.*tel[eé]fono/i],
    answer: "Por ahora el trámite es por WhatsApp, pero si prefieres atención en persona, escribe 'promotor' y coordinamos una visita. Es más rápido y seguro por aquí porque las fotos de tus documentos se procesan al instante.",
  },

  {
    patterns: [/(?:de\s+)?(?:cu[aá]ntos|m[aá]ximo|max)\s+meses/i, /antig[uü]edad/i, /vigencia.*(?:documento|comprobante|constancia)/i, /(?:qu[eé]\s+tan).*(?:reciente|actual)/i],
    answer: "Vigencias máximas de documentos:\n\u2022 Comprobante de domicilio: max 3 meses\n\u2022 Constancia de Situación Fiscal (SAT): max 3 meses\n\u2022 Estado de cuenta bancario: max 3 meses\n\u2022 INE: debe estar vigente (no vencida)\n\u2022 Concesión: debe estar vigente\n\nLos demás documentos (factura, CURP, acta de nacimiento, etc.) no tienen vigencia.",
  },

  // ═══════════════════════════════════════
  // DOCUMENTOS — AYUDA PRÁCTICA
  // ═══════════════════════════════════════
  {
    patterns: [/constancia.*(?:sat|fiscal)/i, /qu[eé]\s+es.*(?:csf|situaci[oó]n\s+fiscal)/i, /d[oó]nde.*(?:saco|consigo|bajo).*(?:sat|fiscal)/i, /csf/i],
    answer: "La Constancia de Situación Fiscal (CSF) debe tener máximo 3 meses de antigüedad. La sacas gratis en la página del SAT (sat.gob.mx) con tu RFC y contraseña, o en cualquier oficina del SAT con tu INE. Si no sabes cómo, tu promotor te puede ayudar.",
  },
  {
    patterns: [/qu[eé]\s+es.*curp/i, /d[oó]nde.*(?:saco|consigo|bajo).*curp/i, /no\s+tengo.*curp/i],
    answer: "El CURP es tu Clave Única de Registro de Población. Lo puedes descargar gratis en gob.mx/curp con tu nombre y fecha de nacimiento. Es un documento de una hoja.",
  },
  {
    patterns: [/qu[eé]\s+es.*clabe/i, /no\s+s[eé].*clabe/i, /d[oó]nde.*(?:veo|encuentro|est[aá]).*clabe/i],
    answer: "La CLABE es un número de 18 dígitos de tu cuenta bancaria. La encuentras en tu estado de cuenta, en tu app del banco, o preguntando en tu sucursal. Empieza con 3 dígitos del banco (ej: 012 = BBVA, 014 = Santander).",
  },
  {
    patterns: [/no\s+tengo.*(?:cuenta|banco)/i, /sin\s+cuenta/i, /necesito.*cuenta.*banco/i],
    answer: "Sí, necesitas una cuenta bancaria a tu nombre para recibir pagos y acreditar identidad. Si no tienes, puedes abrir una cuenta básica en cualquier banco solo con tu INE — es gratis y rápido.",
  },
  {
    patterns: [/no\s+tengo.*factura/i, /perd[ií].*factura/i, /sin\s+factura/i, /factura.*(?:taxi|carro)/i],
    answer: "Si no tienes la factura de tu taxi actual, puedes tramitar una carta factura o una constancia de propiedad. Pregunta a tu promotor y te orientamos con el trámite.",
  },
  {
    patterns: [/ine.*vencid/i, /ine.*tramit/i, /no\s+tengo.*ine/i, /credencial.*vencid/i],
    answer: "Necesitas INE vigente. Si está vencida o en trámite, primero completa tu renovación en el INE y después podemos continuar. No podemos avanzar sin INE vigente.",
  },
  {
    patterns: [/comprobante.*domicilio/i, /no.*(?:tengo|sale).*(?:a\s+mi\s+)?nombre.*domicilio/i],
    answer: "El comprobante de domicilio puede ser recibo de luz, agua, teléfono o internet, no mayor a 3 meses. Si no sale a tu nombre, puede ser del dueño de la casa con una carta simple.",
  },
  {
    patterns: [/historial.*carga/i, /ticket.*(?:gas|gnv|gasolina)/i, /d[oó]nde.*(?:saco|consigo).*historial/i],
    answer: "El historial de cargas son tus tickets o recibos de cuando cargas combustible (gas o gasolina). Guarda tus tickets de las últimas semanas y mándanos foto. Si cargas en estaciones con convenio CMU, ellos nos lo pueden confirmar.",
  },
  {
    patterns: [/carta.*(?:agrupaci[oó]n|gremial|miembr)/i, /qu[eé]\s+es.*agrupaci[oó]n/i],
    answer: "Es una carta de tu grupo o central de taxistas donde estás afiliado, confirmando que eres miembro activo. Pídela en tu agrupación — te la dan en el momento.",
  },
  {
    patterns: [/borrosa|no\s+se\s+ve|(?:foto|imagen).*(?:mal|fea|oscura)/i, /(?:volver|vuelvo).*(?:tomar|mandar)/i],
    answer: "No te preocupes, vuélvela a tomar. Ponla sobre una mesa con buena luz, sin flash, que se vean todas las letras completas. Si necesitas ayuda, escribe 'promotor'.",
  },
  {
    patterns: [/(?:mandar|enviar).*despu[eé]s/i, /no.*(?:tengo|traigo).*(?:ahorita|ahora|conmigo)/i, /(?:puedo|me\s+espero).*(?:ma[nñ]ana|luego|despu[eé]s)/i],
    answer: "Sí, puedes mandar los documentos cuando los tengas. Tu avance se guarda automáticamente. Cuando estés listo, solo escribe aquí y continuamos donde te quedaste.",
  },

  // ═══════════════════════════════════════
  // EDAD Y ELEGIBILIDAD PERSONAL
  // ═══════════════════════════════════════
  {
    patterns: [/(?:ya\s+)?(?:estoy|soy).*(?:grande|viejo|mayor)/i, /l[ií]mite.*edad/i, /edad.*(?:m[aá]xima|l[ií]mite)/i, /(?:cu[aá]ntos|qu[eé]).*a[nñ]os/i],
    answer: "No hay límite de edad. Si tienes concesión vigente en Aguascalientes y puedes operar tu taxi, puedes entrar al programa.",
  },
  {
    patterns: [/(?:mi\s+)?(?:hijo|esposa|familiar|alguien).*(?:tr[aá]mite|hacer|ayudar)/i, /(?:puede\s+ir|puede\s+hacer).*(?:alguien|otro)/i],
    answer: "El titular de la concesión es quien firma el contrato. Un familiar puede ayudarte a capturar documentos y enviarlos por WhatsApp, pero la firma y la entrevista las hace el titular.",
  },
  {
    patterns: [/(?:soy\s+)?mujer/i, /tambi[eé]n.*(?:mujeres|se[nñ]oras)/i],
    answer: "Claro, el programa es para cualquier persona con concesión de taxi vigente en Aguascalientes. Sin distinción.",
  },

  // ═══════════════════════════════════════
  // OPERACIÓN DIARIA DEL VEHÍCULO
  // ═══════════════════════════════════════
  {
    patterns: [/(?:puedo|se\s+puede).*(?:modificar|rin|polarizar|pintar|tunear)/i],
    answer: "El vehículo es de CMU hasta que termines de pagar (mes 36). No se permiten modificaciones estructurales. Accesorios menores como tapetes o fundas sí.",
  },
  {
    patterns: [/publicidad/i, /anuncio/i, /r[oó]tulo/i],
    answer: "No se permite poner publicidad externa en el vehículo sin autorización de CMU. Consulta con tu promotor si tienes una propuesta.",
  },
  {
    patterns: [/cu[aá]nto\s+(?:gasta|consume|rinde)/i, /rendimiento/i, /km.*(?:por|litro)/i],
    answer: "El rendimiento depende del modelo y tu estilo de manejo. En GNV, un March rinde ~14 km/LEQ y un Vento ~12 km/LEQ. El gas es más barato que la gasolina, así que el costo por km es menor.",
  },
  {
    patterns: [/(?:puedo|se\s+puede).*(?:personal|particular|uso\s+propio)/i, /(?:solo|nada\s+m[aá]s).*taxi/i],
    answer: "El vehículo es para operar como taxi. Puedes usarlo para tus traslados personales, pero su uso principal debe ser como unidad de taxi con tu concesión.",
  },

  // ═══════════════════════════════════════
  // POST-VENTA / PROBLEMAS
  // ═══════════════════════════════════════
  {
    patterns: [/no\s+(?:me\s+)?lleg[oó].*(?:liga|link|enlace|pago)/i, /no\s+(?:tengo|recib[ií]).*liga/i],
    answer: "Si no te llegó tu liga de pago, escribe 'promotor' y la generamos de nuevo. También puedes pagar directo a la CLABE 152680120000787681 (Bancrea) con tu folio.",
  },
  {
    patterns: [/ya\s+pagu[eé]/i, /no\s+se\s+(?:refleja|registr)/i, /pagu[eé].*(?:pero|y).*no/i, /(?:hice|mand[eé]).*transferencia/i],
    answer: "Si ya pagaste y no se refleja, mándanos tu comprobante de pago por aquí y lo verificamos. Las transferencias SPEI pueden tardar unas horas en reflejarse.",
  },
  {
    patterns: [/(?:cobr|carg).*(?:de\s+m[aá]s|mal|error)/i, /monto.*(?:mal|incorrecto)/i],
    answer: "Si crees que hay un error en tu cobro, escribe 'promotor' y revisamos tu estado de cuenta detallado. Cada cargo tiene concepto y fecha.",
  },
  {
    patterns: [/(?:me\s+)?robar.*(?:taxi|carro)/i, /robo/i],
    answer: "Reporta de inmediato a tu aseguradora y a la policía. Después notifica a CMU. El seguro cubre el robo si tu póliza está vigente.",
  },
  {
    patterns: [/no\s+puedo\s+trabajar/i, /enferm/i, /incapacidad/i, /hospital/i],
    answer: "Si no puedes trabajar temporalmente por enfermedad, avisa a CMU. El Fondo de Garantía puede cubrir tus cuotas mientras te recuperas. Lo importante es comunicarte, no dejar de pagar sin avisar.",
  },
  {
    patterns: [/(?:quitar|perder|cancel).*concesi[oó]n/i, /(?:si|qu[eé]\s+pasa).*(?:sin|pierdo).*concesi[oó]n/i],
    answer: "La concesión vigente es requisito durante los 36 meses. Si la pierdes, hay que evaluar tu caso con el director de CMU. No pierdas tu concesión.",
  },
  {
    patterns: [/cambiar.*(?:de\s+)?(?:carro|veh[ií]culo|modelo)/i, /(?:quiero|puedo).*otro.*(?:carro|modelo)/i],
    answer: "Una vez firmado el contrato, el vehículo asignado es el que operas los 36 meses. No se puede cambiar de modelo. Elige bien antes de firmar.",
  },

  // ═══════════════════════════════════════
  // INTERACCIONES BÁSICAS
  // ═══════════════════════════════════════
  {
    patterns: [/^gracias$/i, /^muchas\s+gracias$/i, /^te\s+agradezco/i],
    answer: "De nada. Aquí estoy para lo que necesites. Si tienes otra duda, solo escribe.",
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

    const text = await claudeCompletion(
      [
        {
          role: "system",
          content: `Eres el asistente de CMU (Conductores del Mundo), un programa de renovación de taxis en Aguascalientes.
Responde la pregunta del taxista usando SOLO la información del knowledge base. Si no encuentras la respuesta, di "No tengo esa información, pero tu asesor CMU te puede ayudar."
Respuesta corta (2-3 líneas), español coloquial mexicano. Amigable y directo. NO inventes datos.
Usa los términos exactos: "mora" para pagos vencidos, "recargo" para cargos adicionales, "FG" o "Fondo de Garantía" para el depósito de seguridad, "diferencial" para lo que el taxista paga de su bolsillo.

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
