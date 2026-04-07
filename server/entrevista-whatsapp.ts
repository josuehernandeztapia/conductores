/**
 * Entrevista por WhatsApp — Voice Notes
 * 
 * State machine that guides the taxista through 8 questions via WhatsApp.
 * Each answer can be voice note (Whisper transcribes) or text.
 * Numbers are extracted from transcript using LLM.
 * At the end, runs coherencia engine and saves evaluation.
 */

import { PREGUNTAS_TAXI, calcularCoherencia, analizarLexico, transcribirAudio, DatosFinancierosTaxi } from "./evaluacion-taxi";
import { guardarEvaluacion } from "./evaluacion-taxi";

// The 8 questions in order with extraction prompts
const INTERVIEW_STEPS = PREGUNTAS_TAXI.map((p, i) => ({
  index: i,
  id: p.id,
  texto: p.texto,
  campos: p.campos,
  // What to ask the LLM to extract from the transcript
  extractPrompt: getExtractionPrompt(p.id),
}));

function getExtractionPrompt(questionId: string): string {
  switch (questionId) {
    case "actividad_horario":
      return `Extrae EXACTAMENTE estos dos números de la respuesta del taxista:
1. horas_dia: ¿Cuántas HORAS trabaja al DÍA? (normalmente entre 8 y 16)
2. dias_semana: ¿Cuántos DÍAS trabaja a la SEMANA? (normalmente entre 5 y 7)

Ejemplos:
- "trabajo 14 horas, 6 días" → {"horas_dia": 14, "dias_semana": 6}
- "de 8 a 8, toda la semana" → {"horas_dia": 12, "dias_semana": 7}
- "como 10 horas al día, de lunes a sábado" → {"horas_dia": 10, "dias_semana": 6}
- "le meto 12 horas diarias" → {"horas_dia": 12, "dias_semana": 0} (no mencionó días, pon 0)

ATENCIÓN: Si dice "X horas" el valor de horas_dia es X. NO dividas ni recalcules.
Responde SOLO JSON: {"horas_dia": N, "dias_semana": N}`;
    case "servicios_cobro":
      return `Extrae EXACTAMENTE estos dos números:
1. servicios_dia: ¿Cuántos servicios/viajes hace AL DÍA?
2. cobro_promedio_servicio: ¿Cuánto cobra POR SERVICIO en pesos?

ATENCIÓN: Si dice un monto total (ej: "2200 pesos al día") y también dice cuántos servicios, NO dividas. Pon el monto total como cobro_promedio_servicio SOLO si dice "por servicio" o "cada servicio". Si da un monto diario total sin decir "por servicio", pon 0 en cobro_promedio_servicio.

Ejemplos:
- "15 servicios y cobro 200 cada uno" → {"servicios_dia": 15, "cobro_promedio_servicio": 200}
- "hago 15 servicios, saco como 2200 al día" → {"servicios_dia": 15, "cobro_promedio_servicio": 0} (2200 es ingreso total, no por servicio)
- "cobro entre 150 y 200 por viaje, hago unos 12" → {"servicios_dia": 12, "cobro_promedio_servicio": 175}

Responde SOLO JSON: {"servicios_dia": N, "cobro_promedio_servicio": N}`;
    case "ingreso_diario":
      return "Extrae: ingreso_dia (cuánto gana al día en pesos, ingreso bruto). Responde SOLO JSON: {\"ingreso_dia\": N}";
    case "estructura_chofer":
      return "Extrae: tiene_chofer (true/false si tiene chofer o alguien que maneja por él), cuenta_chofer (cuánto le entrega el chofer al día en pesos, 0 si no tiene), num_taxis (cuántos taxis tiene). Responde SOLO JSON: {\"tiene_chofer\": true/false, \"cuenta_chofer\": N, \"num_taxis\": N}";
    case "gasto_combustible":
      return "Extrae: gasto_combustible_dia (cuánto gasta de gasolina o gas al día en pesos). Responde SOLO JSON: {\"gasto_combustible_dia\": N}";
    case "gastos_vehiculo":
      return "Extrae: mantenimiento_mes (gasto mensual en mantenimiento del taxi en pesos) y otros_gastos_vehiculo (otros gastos mensuales del vehículo como seguro, verificación en pesos). Responde SOLO JSON: {\"mantenimiento_mes\": N, \"otros_gastos_vehiculo\": N}";
    case "carga_financiera":
      return "Extrae: otros_creditos_mes (cuánto paga al mes en otros créditos, Coppel, Elektra, casa, etc. en pesos. 0 si no tiene). Responde SOLO JSON: {\"otros_creditos_mes\": N}";
    case "resiliencia":
      return "No hay números que extraer. Responde: {\"resiliencia_ok\": true}";
    default:
      return "Responde: {}";
  }
}

export interface InterviewState {
  folioId: string;
  currentQuestion: number; // 0-7
  answers: Record<string, any>; // accumulated campos
  transcripts: { pregunta_id: string; transcript: string; audio_duration_ms: number; features: any }[];
}

export function getInterviewWelcome(): string {
  return "Vamos a hacerte unas preguntas rápidas para evaluar tu perfil. Son 8 preguntas. Puedes contestar con *nota de voz* o texto.\n\nEmpezamos:";
}

export function getCurrentQuestion(state: InterviewState): string {
  const step = INTERVIEW_STEPS[state.currentQuestion];
  if (!step) return "";
  return `*Pregunta ${state.currentQuestion + 1} de 8:*\n${step.texto}`;
}

export async function processAnswer(
  state: InterviewState,
  transcript: string,
  audioDurationMs: number,
  llmCall: (messages: any[], maxTokens: number) => Promise<string>,
): Promise<{
  newState: InterviewState;
  reply: string;
  isComplete: boolean;
  evaluation?: any;
}> {
  const step = INTERVIEW_STEPS[state.currentQuestion];
  
  // Analyze lexicon
  const lexico = analizarLexico(transcript);
  
  // Extract numbers from transcript using LLM (except resiliencia)
  let extracted: Record<string, any> = {};
  if (step.id !== "resiliencia" && step.campos.length > 0) {
    try {
      const extractionResult = await llmCall([
        { role: "system", content: "Eres un extractor de datos num\u00e9ricos. Analiza la respuesta de un taxista mexicano y extrae los n\u00fameros EXACTOS que menciona. NUNCA recalcules, dividas ni modifiques los n\u00fameros. Si dice \"14 horas\", horas_dia=14. Si no puedes determinar un valor, usa 0. Responde SOLO JSON v\u00e1lido." },
        { role: "user", content: `Respuesta del taxista: "${transcript}"\n\n${step.extractPrompt}` },
      ], 100);
      
      // Parse JSON from LLM response
      const jsonMatch = extractionResult.match(/\{[^}]+\}/);
      if (jsonMatch) {
        extracted = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.error(`[Interview] Extraction failed for ${step.id}:`, e);
    }
  }

  // Merge extracted values
  const newAnswers = { ...state.answers, ...extracted };
  
  // Save transcript
  const newTranscripts = [...state.transcripts, {
    pregunta_id: step.id,
    transcript,
    audio_duration_ms: audioDurationMs,
    features: lexico,
  }];

  const nextQuestion = state.currentQuestion + 1;
  
  // Check if we need to confirm extracted values (if they seem off)
  let confirmationNote = "";
  if (step.id !== "resiliencia" && Object.keys(extracted).length > 0) {
    const NON_MONEY_FIELDS = new Set([
      'horas_dia', 'dias_semana', 'servicios_dia', 'num_taxis',
      'tiene_chofer', 'resiliencia_ok',
    ]);
    const vals = Object.entries(extracted)
      .filter(([_, v]) => v !== null && v !== undefined)
      .map(([k, v]) => {
        if (typeof v === 'boolean') return `${k}: ${v ? 'sí' : 'no'}`;
        if (typeof v === 'number' && v === 0) return `${k}: 0`;
        if (typeof v === 'number' && NON_MONEY_FIELDS.has(k)) return `${k}: ${v}`;
        if (typeof v === 'number') return `${k}: $${v.toLocaleString()}`;
        return `${k}: ${v}`;
      })
      .join(", ");
    if (vals) {
      confirmationNote = `\n_Entendí: ${vals}_`;
    }
  }

  if (nextQuestion >= 8) {
    // Interview complete — run coherencia
    const datos: DatosFinancierosTaxi = {
      horas_dia: Number(newAnswers.horas_dia) || 0,
      dias_semana: Number(newAnswers.dias_semana) || 0,
      servicios_dia: Number(newAnswers.servicios_dia) || 0,
      cobro_promedio_servicio: Number(newAnswers.cobro_promedio_servicio) || 0,
      ingreso_dia: Number(newAnswers.ingreso_dia) || 0,
      tiene_chofer: newAnswers.tiene_chofer === true,
      cuenta_chofer: Number(newAnswers.cuenta_chofer) || 0,
      num_taxis: Number(newAnswers.num_taxis) || 1,
      gasto_combustible_dia: Number(newAnswers.gasto_combustible_dia) || 0,
      mantenimiento_mes: Number(newAnswers.mantenimiento_mes) || 0,
      otros_gastos_vehiculo: Number(newAnswers.otros_gastos_vehiculo) || 0,
      otros_creditos_mes: Number(newAnswers.otros_creditos_mes) || 0,
      cuota_cmu_mensual: 5500, // estimated
    };

    const coherencia = calcularCoherencia(datos);

    // Aggregate voice features
    let totalMuletillas = 0, totalEvasion = 0, totalNegacion = 0, totalHonestidad = 0;
    let sumDisfluency = 0, sumHonesty = 0;
    for (const t of newTranscripts) {
      if (t.features) {
        totalMuletillas += t.features.muletillas_count || 0;
        totalEvasion += t.features.evasion_count || 0;
        totalNegacion += t.features.negacion_tajante_count || 0;
        totalHonestidad += t.features.honestidad_count || 0;
        sumDisfluency += t.features.disfluency_rate || 0;
        sumHonesty += t.features.honesty_score || 0;
      }
    }

    // Save to DB
    let evalId: number | null = null;
    try {
      evalId = await guardarEvaluacion({
        folio_id: state.folioId,
        datos,
        coherencia,
        voice_responses: newTranscripts,
        voice_aggregate: {
          total_muletillas: totalMuletillas,
          total_evasion: totalEvasion,
          total_negacion_tajante: totalNegacion,
          total_honestidad: totalHonestidad,
          avg_disfluency_rate: sumDisfluency / 8,
          avg_honesty_score: sumHonesty / 8,
          voice_flags: [],
        },
      });
    } catch (e) {
      console.error("[Interview] Save failed:", e);
    }

    return {
      newState: { ...state, currentQuestion: 8, answers: newAnswers, transcripts: newTranscripts },
      reply: `${confirmationNote}\n\nEntrevista completada. Tu evaluación está en revisión. Tu asesor(a) CMU te contactará con el resultado.`,
      isComplete: true,
      evaluation: { evalId, coherencia, datos },
    };
  }

  // Next question
  const nextQ = INTERVIEW_STEPS[nextQuestion];
  return {
    newState: { ...state, currentQuestion: nextQuestion, answers: newAnswers, transcripts: newTranscripts },
    reply: `${confirmationNote}\n\n*Pregunta ${nextQuestion + 1} de 8:*\n${nextQ.texto}`,
    isComplete: false,
  };
}
