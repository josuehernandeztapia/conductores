/**
 * Evaluación Rápida Taxi — Motor de coherencia financiera + Voice Pattern (pasivo)
 * 
 * Contexto: Taxi urbano Aguascalientes. NO es ruta fija.
 * El scoring financiero DECIDE (GO/REVIEW/NO-GO).
 * El voice pattern se REGISTRA pero no decide (aún).
 * 
 * Flujo: Ángeles hace 8 preguntas por voz → audio se transcribe → 
 *        números se extraen/confirman → motor de coherencia corre → decisión.
 */

import { neon } from "@neondatabase/serverless";

// ===== CONSTANTS: TAXI AGUASCALIENTES =====

const TAXI_AGS_BENCHMARKS = {
  // Ingreso diario bruto (taxista promedio Aguascalientes)
  ingreso_dia_min: 400,      // muy bajo pero posible (taxi viejo, pocas horas)
  ingreso_dia_max: 2000,     // límite creíble taxi urbano
  ingreso_dia_promedio: 900,  // benchmark referencia
  
  // Combustible
  rendimiento_km_lt: 12,       // km/lt taxi urbano ciudad media
  precio_combustible: 22.5,    // precio promedio gasolina Aguascalientes 2026
  precio_gnv_equivalente: 14,  // GNV es ~40% más barato
  
  // Servicios
  km_por_servicio: 8,          // promedio taxi urbano
  servicios_max_dia: 30,       // límite creíble (12h × ~2.5/hr)
  
  // Ratios de decisión (más estrictos que ruta fija por volatilidad)
  ratio_cuota_nogo: 0.35,     // cuota > 35% flujo libre = NO-GO
  ratio_cuota_review: 0.25,   // cuota 25-35% = REVIEW
  // < 25% = GO
  
  // Coherencia
  ratio_ingreso_min: 0.8,     // ingreso declarado / estimado mínimo
  ratio_ingreso_max: 1.3,     // ingreso declarado / estimado máximo
  
  // Cuenta chofer (si tiene)
  cuenta_chofer_min_pct: 0.50, // el chofer entrega mínimo 50% del bruto
};

// ===== LEXICONS: TAXI MEXICANO =====

const LEXICON_MULETILLAS = [
  "pues", "este", "eh", "mmm", "aaah", "orale", "ajá",
  "digamos", "osea", "ósea", "verdad", "no?",
];

const LEXICON_EVASION = [
  "aproximadamente", "mas o menos", "más o menos", "depende",
  "varía", "varia", "no sé", "no se", "creo que", "debe ser",
  "poquito", "casi nada", "es complicado", "luego vemos",
  "ahorita no", "no me acuerdo", "quién sabe",
];

const LEXICON_NEGACION_TAJANTE = [
  "nunca", "jamás", "jamas", "para nada", "eso no existe",
  "no pago nada", "nunca ha pasado", "nunca me atraso",
  "siempre pago", "cero problemas", "todo perfecto",
];

const LEXICON_HONESTIDAD = [
  "mi hijo", "mi esposa", "mi hermano", "mi socio",
  "ahorro", "tanda", "caja", "respaldo", "apoyo",
  "familia", "me ayuda", "trabajo más", "horas extra",
  "otra ruta", "fin de semana",
];

// ===== PREGUNTAS: 8 PARA TAXI AGUASCALIENTES =====

export const PREGUNTAS_TAXI = [
  {
    id: "actividad_horario",
    texto: "¿Cuántas horas y días trabaja a la semana?",
    categoria: "actividad_operativa",
    campos: ["horas_dia", "dias_semana"],
    peso: 6,
    stress_level: 1,
    expected_response_time_ms: 8000,
  },
  {
    id: "servicios_cobro",
    texto: "¿Cuántos servicios hace al día y cuánto cobra en promedio por servicio?",
    categoria: "actividad_operativa",
    campos: ["servicios_dia", "cobro_promedio_servicio"],
    peso: 9,
    stress_level: 2,
    expected_response_time_ms: 10000,
  },
  {
    id: "ingreso_diario",
    texto: "¿Cuánto hace al día de ingreso bruto?",
    categoria: "actividad_operativa",
    campos: ["ingreso_dia"],
    peso: 10,
    stress_level: 3,
    expected_response_time_ms: 8000,
  },
  {
    id: "estructura_chofer",
    texto: "¿Tiene chofer? ¿Cuánto le entrega al día? ¿Tiene más de un taxi?",
    categoria: "estructura_operativa",
    campos: ["tiene_chofer", "cuenta_chofer", "num_taxis"],
    peso: 7,
    stress_level: 2,
    expected_response_time_ms: 12000,
  },
  {
    id: "gasto_combustible",
    texto: "¿Cuánto gasta de combustible al día?",
    categoria: "gastos_operativos",
    campos: ["gasto_combustible_dia"],
    peso: 8,
    stress_level: 2,
    expected_response_time_ms: 8000,
  },
  {
    id: "gastos_vehiculo",
    texto: "¿Gastos mensuales del taxi? Mantenimiento, seguro, verificación...",
    categoria: "gastos_operativos",
    campos: ["mantenimiento_mes", "otros_gastos_vehiculo"],
    peso: 6,
    stress_level: 2,
    expected_response_time_ms: 12000,
  },
  {
    id: "carga_financiera",
    texto: "¿Tiene otros créditos o pagos fijos mensuales?",
    categoria: "carga_financiera",
    campos: ["otros_creditos_mes"],
    peso: 8,
    stress_level: 4,
    expected_response_time_ms: 10000,
  },
  {
    id: "resiliencia",
    texto: "Si no puede manejar, ¿quién cubre la unidad? Si sube el gas, ¿cómo ajusta?",
    categoria: "resiliencia",
    campos: [],
    peso: 7,
    stress_level: 4,
    expected_response_time_ms: 15000,
  },
];

// ===== TYPES =====

export interface DatosFinancierosTaxi {
  horas_dia: number;
  dias_semana: number;
  servicios_dia: number;
  cobro_promedio_servicio: number;
  ingreso_dia: number;
  tiene_chofer: boolean;
  cuenta_chofer: number;       // 0 si no tiene chofer
  num_taxis: number;
  gasto_combustible_dia: number;
  mantenimiento_mes: number;
  otros_gastos_vehiculo: number;
  otros_creditos_mes: number;
  cuota_cmu_mensual: number;   // se calcula del vehículo seleccionado
}

export interface BanderaCoherencia {
  tipo: string;
  descripcion: string;
  severidad: "INFO" | "WARNING" | "CRITICAL";
  valores: Record<string, number | string>;
}

export interface ResultadoCoherencia {
  decision: "GO" | "REVIEW" | "NO-GO";
  score_coherencia: number;           // 0-100
  ingreso_estimado: number;
  ingreso_declarado: number;
  ratio_ingreso: number;
  km_dia_estimados: number;
  ingreso_real_mensual: number;
  gastos_totales_mes: number;
  flujo_libre_mes: number;
  ratio_cuota: number;
  banderas: BanderaCoherencia[];
  resumen: string;
}

export interface VoiceFeatures {
  transcript: string;
  confidence: number;
  response_time_ms: number;
  word_count: number;
  muletillas_count: number;
  evasion_count: number;
  negacion_tajante_count: number;
  honestidad_count: number;
  disfluency_rate: number;        // muletillas / 100 palabras
  evasion_rate: number;            // evasión / total palabras
  honesty_score: number;           // 0-1
  lexical_flags: string[];
}

export interface EvaluacionCompleta {
  folio_id: string;
  datos_financieros: DatosFinancierosTaxi;
  coherencia: ResultadoCoherencia;
  voice_responses: {
    pregunta_id: string;
    audio_duration_ms: number;
    features: VoiceFeatures;
  }[];
  decision_final: "GO" | "REVIEW" | "NO-GO";
  created_at: string;
}

// ===== MOTOR DE COHERENCIA FINANCIERA =====

export function calcularCoherencia(
  datos: DatosFinancierosTaxi
): ResultadoCoherencia {
  const B = TAXI_AGS_BENCHMARKS;
  const banderas: BanderaCoherencia[] = [];

  // 1. Ingreso estimado vs declarado
  const ingreso_estimado = datos.servicios_dia * datos.cobro_promedio_servicio;
  const ratio_ingreso = ingreso_estimado > 0 
    ? datos.ingreso_dia / ingreso_estimado 
    : 0;

  if (ratio_ingreso < B.ratio_ingreso_min || ratio_ingreso > B.ratio_ingreso_max) {
    banderas.push({
      tipo: "INGRESO_INCOHERENTE",
      descripcion: `Ingreso declarado ($${datos.ingreso_dia}) vs estimado ($${ingreso_estimado.toFixed(0)}) por servicios × cobro no cuadran (ratio ${ratio_ingreso.toFixed(2)})`,
      severidad: ratio_ingreso < 0.6 || ratio_ingreso > 1.6 ? "CRITICAL" : "WARNING",
      valores: { declarado: datos.ingreso_dia, estimado: ingreso_estimado, ratio: ratio_ingreso },
    });
  }

  // 2. Benchmark ingreso creíble
  if (datos.ingreso_dia > B.ingreso_dia_max) {
    banderas.push({
      tipo: "INGRESO_EXCESIVO",
      descripcion: `Ingreso declarado ($${datos.ingreso_dia}/día) supera benchmark máximo taxi Aguascalientes ($${B.ingreso_dia_max})`,
      severidad: "CRITICAL",
      valores: { declarado: datos.ingreso_dia, max_benchmark: B.ingreso_dia_max },
    });
  }
  if (datos.ingreso_dia < B.ingreso_dia_min) {
    banderas.push({
      tipo: "INGRESO_MUY_BAJO",
      descripcion: `Ingreso declarado ($${datos.ingreso_dia}/día) es muy bajo para cubrir cuota CMU`,
      severidad: "WARNING",
      valores: { declarado: datos.ingreso_dia, min_benchmark: B.ingreso_dia_min },
    });
  }

  // 3. Km inferidos del combustible
  const km_dia_estimados = (datos.gasto_combustible_dia / B.precio_combustible) * B.rendimiento_km_lt;

  // 4. Servicios vs km coherencia
  const servicios_estimados_por_km = km_dia_estimados / B.km_por_servicio;
  if (datos.servicios_dia > servicios_estimados_por_km * 1.4 && datos.servicios_dia > 5) {
    banderas.push({
      tipo: "SERVICIOS_VS_COMBUSTIBLE",
      descripcion: `Declara ${datos.servicios_dia} servicios/día pero combustible solo alcanza para ~${servicios_estimados_por_km.toFixed(0)} servicios (${km_dia_estimados.toFixed(0)} km estimados)`,
      severidad: "WARNING",
      valores: { servicios_declarados: datos.servicios_dia, servicios_por_km: servicios_estimados_por_km, km_estimados: km_dia_estimados },
    });
  }

  // 5. Servicios máximos creíbles
  if (datos.servicios_dia > B.servicios_max_dia) {
    banderas.push({
      tipo: "SERVICIOS_EXCESIVOS",
      descripcion: `${datos.servicios_dia} servicios/día no es creíble para taxi urbano (máx ~${B.servicios_max_dia})`,
      severidad: "CRITICAL",
      valores: { declarados: datos.servicios_dia, max: B.servicios_max_dia },
    });
  }

  // 6. Cuenta chofer validación
  if (datos.tiene_chofer && datos.cuenta_chofer > 0) {
    const pct_cuenta = datos.cuenta_chofer / datos.ingreso_dia;
    if (pct_cuenta < B.cuenta_chofer_min_pct) {
      banderas.push({
        tipo: "CUENTA_CHOFER_BAJA",
        descripcion: `Chofer entrega $${datos.cuenta_chofer}/día (${(pct_cuenta * 100).toFixed(0)}% del bruto) — por debajo del ${(B.cuenta_chofer_min_pct * 100)}% esperado`,
        severidad: "WARNING",
        valores: { cuenta: datos.cuenta_chofer, ingreso: datos.ingreso_dia, pct: pct_cuenta },
      });
    }
  }

  // 7. Flujo mensual
  const ingreso_real_dia = datos.tiene_chofer && datos.cuenta_chofer > 0
    ? datos.cuenta_chofer
    : datos.ingreso_dia;

  const ingreso_real_mensual = ingreso_real_dia * datos.dias_semana * 4.33;
  const gasto_combustible_mes = datos.gasto_combustible_dia * datos.dias_semana * 4.33;
  const gastos_totales_mes = gasto_combustible_mes + datos.mantenimiento_mes + datos.otros_gastos_vehiculo;
  const flujo_libre_mes = ingreso_real_mensual - gastos_totales_mes - datos.otros_creditos_mes;

  // 8. Ratio cuota CMU
  const ratio_cuota = flujo_libre_mes > 0 
    ? datos.cuota_cmu_mensual / flujo_libre_mes 
    : 999;

  if (flujo_libre_mes <= 0) {
    banderas.push({
      tipo: "FLUJO_NEGATIVO",
      descripcion: `Flujo libre mensual es negativo ($${flujo_libre_mes.toFixed(0)}). No hay capacidad de pago.`,
      severidad: "CRITICAL",
      valores: { ingreso_mes: ingreso_real_mensual, gastos_mes: gastos_totales_mes, creditos_mes: datos.otros_creditos_mes },
    });
  } else if (ratio_cuota > B.ratio_cuota_nogo) {
    banderas.push({
      tipo: "CUOTA_EXCESIVA",
      descripcion: `Cuota CMU ($${datos.cuota_cmu_mensual.toLocaleString()}) consume ${(ratio_cuota * 100).toFixed(0)}% del flujo libre ($${flujo_libre_mes.toFixed(0)}). Máximo permitido: ${(B.ratio_cuota_nogo * 100)}%`,
      severidad: "CRITICAL",
      valores: { cuota: datos.cuota_cmu_mensual, flujo_libre: flujo_libre_mes, ratio: ratio_cuota },
    });
  } else if (ratio_cuota > B.ratio_cuota_review) {
    banderas.push({
      tipo: "CUOTA_AJUSTADA",
      descripcion: `Cuota CMU consume ${(ratio_cuota * 100).toFixed(0)}% del flujo libre. Dentro de límites pero ajustado.`,
      severidad: "WARNING",
      valores: { cuota: datos.cuota_cmu_mensual, flujo_libre: flujo_libre_mes, ratio: ratio_cuota },
    });
  }

  // 9. Score de coherencia (0-100)
  let score = 100;
  for (const b of banderas) {
    if (b.severidad === "CRITICAL") score -= 25;
    else if (b.severidad === "WARNING") score -= 10;
    else score -= 3;
  }
  score = Math.max(0, Math.min(100, score));

  // Bonus por coherencia perfecta
  if (ratio_ingreso >= 0.9 && ratio_ingreso <= 1.1) score = Math.min(100, score + 5);
  if (datos.num_taxis > 1) score = Math.min(100, score + 5);

  // 10. Decisión
  const critical_count = banderas.filter(b => b.severidad === "CRITICAL").length;
  let decision: "GO" | "REVIEW" | "NO-GO";

  if (critical_count >= 2 || flujo_libre_mes <= 0 || ratio_cuota > B.ratio_cuota_nogo) {
    decision = "NO-GO";
  } else if (critical_count === 1 || banderas.filter(b => b.severidad === "WARNING").length >= 3 || ratio_cuota > B.ratio_cuota_review) {
    decision = "REVIEW";
  } else {
    decision = "GO";
  }

  // Resumen legible
  const resumen = decision === "GO"
    ? `Coherencia financiera OK. Flujo libre $${flujo_libre_mes.toFixed(0)}/mes, cuota CMU ${(ratio_cuota * 100).toFixed(0)}% del disponible.`
    : decision === "REVIEW"
    ? `Requiere revisión. ${banderas.length} observación(es): ${banderas.map(b => b.tipo).join(", ")}`
    : `No viable. ${critical_count} bandera(s) crítica(s): ${banderas.filter(b => b.severidad === "CRITICAL").map(b => b.tipo).join(", ")}`;

  return {
    decision,
    score_coherencia: score,
    ingreso_estimado,
    ingreso_declarado: datos.ingreso_dia,
    ratio_ingreso,
    km_dia_estimados,
    ingreso_real_mensual,
    gastos_totales_mes,
    flujo_libre_mes,
    ratio_cuota,
    banderas,
    resumen,
  };
}

// ===== ANÁLISIS LÉXICO =====

export function analizarLexico(transcript: string): Omit<VoiceFeatures, "transcript" | "confidence" | "response_time_ms"> {
  const palabras = transcript.toLowerCase().split(/\s+/).filter(Boolean);
  const texto = transcript.toLowerCase();
  const word_count = palabras.length;

  // Conteos
  let muletillas_count = 0;
  let evasion_count = 0;
  let negacion_tajante_count = 0;
  let honestidad_count = 0;
  const lexical_flags: string[] = [];

  for (const m of LEXICON_MULETILLAS) {
    const regex = new RegExp(`\\b${m.replace(/[?]/g, "\\?")}\\b`, "gi");
    const matches = texto.match(regex);
    if (matches) muletillas_count += matches.length;
  }

  for (const e of LEXICON_EVASION) {
    if (texto.includes(e)) {
      evasion_count++;
      lexical_flags.push(`evasion:${e}`);
    }
  }

  for (const n of LEXICON_NEGACION_TAJANTE) {
    if (texto.includes(n)) {
      negacion_tajante_count++;
      lexical_flags.push(`negacion_tajante:${n}`);
    }
  }

  for (const h of LEXICON_HONESTIDAD) {
    if (texto.includes(h)) honestidad_count++;
  }

  // Rates
  const disfluency_rate = word_count > 0 ? (muletillas_count / word_count) * 100 : 0;
  const evasion_rate = word_count > 0 ? evasion_count / word_count : 0;

  // Honesty score: 0-1. Más términos honestos + menos evasión = mejor
  const honesty_raw = (honestidad_count * 0.3) - (evasion_count * 0.2) - (negacion_tajante_count * 0.4);
  const honesty_score = Math.max(0, Math.min(1, 0.5 + honesty_raw));

  // Flags de alto riesgo
  if (negacion_tajante_count >= 2) lexical_flags.push("PATRON_NEGACION_TAJANTE");
  if (disfluency_rate > 15) lexical_flags.push("ALTA_DISFLUENCIA");
  if (evasion_count >= 3) lexical_flags.push("PATRON_EVASIVO");
  if (honestidad_count === 0 && word_count > 10) lexical_flags.push("SIN_INDICADORES_HONESTIDAD");

  return {
    word_count,
    muletillas_count,
    evasion_count,
    negacion_tajante_count,
    honestidad_count,
    disfluency_rate,
    evasion_rate,
    honesty_score,
    lexical_flags,
  };
}

// ===== WHISPER INTEGRATION =====

export async function transcribirAudio(
  audioBuffer: Buffer,
  preguntaId: string
): Promise<{ transcript: string; confidence: number; words: any[] }> {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  
  if (!OPENAI_API_KEY) {
    console.warn("[Whisper] No OPENAI_API_KEY — returning empty transcript");
    return { transcript: "", confidence: 0, words: [] };
  }

  const FormDataModule = await import("form-data");
  const FormDataClass = FormDataModule.default || FormDataModule;
  const form = new FormDataClass();
  form.append("file", audioBuffer, {
    filename: `eval-${preguntaId}-${Date.now()}.webm`,
    contentType: "audio/webm",
  });
  form.append("model", "whisper-1");
  form.append("language", "es");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("prompt", "Entrevista financiera con taxista mexicano. Incluir pausas y muletillas.");

  try {
    const fetch = (await import("node-fetch")).default;
    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form as any,
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[Whisper] API error: ${resp.status} ${err}`);
      return { transcript: "", confidence: 0, words: [] };
    }

    const data: any = await resp.json();
    
    // Calculate average confidence from words
    const words = data.words || [];
    const avgConfidence = words.length > 0
      ? words.reduce((sum: number, w: any) => sum + (w.confidence || 0.8), 0) / words.length
      : 0.8;

    return {
      transcript: data.text || "",
      confidence: avgConfidence,
      words,
    };
  } catch (err: any) {
    console.error(`[Whisper] Error: ${err.message}`);
    return { transcript: "", confidence: 0, words: [] };
  }
}

// ===== VOICE FEATURES (PASIVOS — registrar, no decidir) =====

export function extraerVoiceFeaturesFromWhisper(
  words: any[],
  totalDurationMs: number
): { pause_count: number; avg_pause_ms: number; speech_rate_wpm: number; timing_variance: number } {
  if (!words || words.length < 2) {
    return { pause_count: 0, avg_pause_ms: 0, speech_rate_wpm: 0, timing_variance: 0 };
  }

  // Pausas entre palabras
  const gaps: number[] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = (words[i].start - words[i - 1].end) * 1000; // ms
    if (gap > 0) gaps.push(gap);
  }

  const pause_count = gaps.filter(g => g > 500).length; // pausas > 500ms
  const avg_pause_ms = gaps.length > 0 
    ? gaps.reduce((a, b) => a + b, 0) / gaps.length 
    : 0;

  // Velocidad de habla
  const durationSec = totalDurationMs / 1000;
  const speech_rate_wpm = durationSec > 0 ? (words.length / durationSec) * 60 : 0;

  // Varianza de timing (proxy de nerviosismo)
  const mean = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const timing_variance = gaps.length > 0
    ? gaps.reduce((acc, g) => acc + Math.pow(g - mean, 2), 0) / gaps.length
    : 0;

  return { pause_count, avg_pause_ms, speech_rate_wpm, timing_variance };
}

// ===== NEON PERSISTENCE =====

const getSQL = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("No DATABASE_URL");
  return neon(url);
};

export async function crearTablaEvaluaciones(): Promise<void> {
  const sql = getSQL();
  await sql`
    CREATE TABLE IF NOT EXISTS evaluaciones_taxi (
      id SERIAL PRIMARY KEY,
      folio_id TEXT NOT NULL,
      
      -- Datos financieros (las 8 preguntas)
      horas_dia NUMERIC,
      dias_semana NUMERIC,
      servicios_dia NUMERIC,
      cobro_promedio_servicio NUMERIC,
      ingreso_dia NUMERIC,
      tiene_chofer BOOLEAN DEFAULT false,
      cuenta_chofer NUMERIC DEFAULT 0,
      num_taxis INTEGER DEFAULT 1,
      gasto_combustible_dia NUMERIC,
      mantenimiento_mes NUMERIC,
      otros_gastos_vehiculo NUMERIC,
      otros_creditos_mes NUMERIC DEFAULT 0,
      cuota_cmu_mensual NUMERIC,
      
      -- Resultado coherencia
      decision TEXT NOT NULL,  -- GO / REVIEW / NO-GO
      score_coherencia NUMERIC,
      ingreso_estimado NUMERIC,
      ratio_ingreso NUMERIC,
      km_dia_estimados NUMERIC,
      ingreso_real_mensual NUMERIC,
      gastos_totales_mes NUMERIC,
      flujo_libre_mes NUMERIC,
      ratio_cuota NUMERIC,
      banderas JSONB DEFAULT '[]',
      resumen TEXT,
      
      -- Voice responses (8 preguntas con audio)
      voice_responses JSONB DEFAULT '[]',
      
      -- Voice aggregate features (pasivos)
      total_muletillas INTEGER DEFAULT 0,
      total_evasion INTEGER DEFAULT 0,
      total_negacion_tajante INTEGER DEFAULT 0,
      total_honestidad INTEGER DEFAULT 0,
      avg_disfluency_rate NUMERIC DEFAULT 0,
      avg_honesty_score NUMERIC DEFAULT 0,
      voice_flags JSONB DEFAULT '[]',
      
      -- Resultado real (se llena después, para calibración futura)
      resultado_pago TEXT,          -- 'al_dia' / 'mora' / 'fg' / 'rescision'
      meses_al_dia INTEGER,
      
      -- Meta
      evaluador TEXT DEFAULT 'angeles',
      override_decision TEXT,        -- si Ángeles o Josué cambian la decisión
      override_motivo TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  console.log("[Evaluación] Tabla evaluaciones_taxi creada/verificada");
}

export async function guardarEvaluacion(eval_data: {
  folio_id: string;
  datos: DatosFinancierosTaxi;
  coherencia: ResultadoCoherencia;
  voice_responses: any[];
  voice_aggregate: {
    total_muletillas: number;
    total_evasion: number;
    total_negacion_tajante: number;
    total_honestidad: number;
    avg_disfluency_rate: number;
    avg_honesty_score: number;
    voice_flags: string[];
  };
}): Promise<number> {
  const sql = getSQL();
  const d = eval_data.datos;
  const c = eval_data.coherencia;
  const v = eval_data.voice_aggregate;

  const result = await sql`
    INSERT INTO evaluaciones_taxi (
      folio_id,
      horas_dia, dias_semana, servicios_dia, cobro_promedio_servicio,
      ingreso_dia, tiene_chofer, cuenta_chofer, num_taxis,
      gasto_combustible_dia, mantenimiento_mes, otros_gastos_vehiculo,
      otros_creditos_mes, cuota_cmu_mensual,
      decision, score_coherencia, ingreso_estimado, ratio_ingreso,
      km_dia_estimados, ingreso_real_mensual, gastos_totales_mes,
      flujo_libre_mes, ratio_cuota, banderas, resumen,
      voice_responses,
      total_muletillas, total_evasion, total_negacion_tajante,
      total_honestidad, avg_disfluency_rate, avg_honesty_score, voice_flags
    ) VALUES (
      ${eval_data.folio_id},
      ${d.horas_dia}, ${d.dias_semana}, ${d.servicios_dia}, ${d.cobro_promedio_servicio},
      ${d.ingreso_dia}, ${d.tiene_chofer}, ${d.cuenta_chofer}, ${d.num_taxis},
      ${d.gasto_combustible_dia}, ${d.mantenimiento_mes}, ${d.otros_gastos_vehiculo},
      ${d.otros_creditos_mes}, ${d.cuota_cmu_mensual},
      ${c.decision}, ${c.score_coherencia}, ${c.ingreso_estimado}, ${c.ratio_ingreso},
      ${c.km_dia_estimados}, ${c.ingreso_real_mensual}, ${c.gastos_totales_mes},
      ${c.flujo_libre_mes}, ${c.ratio_cuota}, ${JSON.stringify(c.banderas)}, ${c.resumen},
      ${JSON.stringify(eval_data.voice_responses)},
      ${v.total_muletillas}, ${v.total_evasion}, ${v.total_negacion_tajante},
      ${v.total_honestidad}, ${v.avg_disfluency_rate}, ${v.avg_honesty_score},
      ${JSON.stringify(v.voice_flags)}
    )
    RETURNING id
  `;
  return result[0]?.id;
}

export async function obtenerEvaluacion(folioId: string): Promise<any> {
  const sql = getSQL();
  const rows = await sql`
    SELECT * FROM evaluaciones_taxi WHERE folio_id = ${folioId} ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0] || null;
}

export async function actualizarResultadoPago(
  folioId: string,
  resultado: "al_dia" | "mora" | "fg" | "rescision",
  meses_al_dia: number
): Promise<void> {
  const sql = getSQL();
  await sql`
    UPDATE evaluaciones_taxi 
    SET resultado_pago = ${resultado}, meses_al_dia = ${meses_al_dia}, updated_at = NOW()
    WHERE folio_id = ${folioId}
  `;
}
