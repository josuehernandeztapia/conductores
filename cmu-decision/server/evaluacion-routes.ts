/**
 * Evaluación Rápida Taxi — API Routes
 * 
 * POST /api/evaluacion/coherencia     — Corre motor de coherencia con datos financieros
 * POST /api/evaluacion/voice-analyze  — Recibe audio, transcribe, analiza léxico
 * POST /api/evaluacion/completa       — Datos financieros + voice responses → decisión final + guardar
 * GET  /api/evaluacion/:folioId       — Consulta evaluación guardada
 * GET  /api/evaluacion/preguntas      — Devuelve las 8 preguntas
 * POST /api/evaluacion/init-db        — Crear tabla (una vez)
 * PATCH /api/evaluacion/:folioId/override — Ángeles/Josué cambia decisión manualmente
 * PATCH /api/evaluacion/:folioId/resultado — Registrar resultado de pago (para calibración)
 */

import { Router, Request, Response } from "express";
import * as multer from "multer";
import {
  PREGUNTAS_TAXI,
  calcularCoherencia,
  analizarLexico,
  transcribirAudio,
  extraerVoiceFeaturesFromWhisper,
  crearTablaEvaluaciones,
  guardarEvaluacion,
  obtenerEvaluacion,
  actualizarResultadoPago,
  DatosFinancierosTaxi,
  VoiceFeatures,
} from "./evaluacion-taxi";

const router = Router();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// ===== GET /api/evaluacion/preguntas =====
router.get("/preguntas", (_req: Request, res: Response) => {
  res.json({ preguntas: PREGUNTAS_TAXI });
});

// ===== POST /api/evaluacion/coherencia =====
// Body: DatosFinancierosTaxi
router.post("/coherencia", (req: Request, res: Response) => {
  try {
    const datos = req.body as DatosFinancierosTaxi;
    
    // Validaciones básicas
    if (!datos.servicios_dia || !datos.ingreso_dia || !datos.cuota_cmu_mensual) {
      return res.status(400).json({ 
        error: "Faltan campos requeridos: servicios_dia, ingreso_dia, cuota_cmu_mensual" 
      });
    }

    const resultado = calcularCoherencia(datos);
    res.json({ success: true, resultado });
  } catch (err: any) {
    console.error("[Evaluación] Error coherencia:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== POST /api/evaluacion/voice-analyze =====
// multipart/form-data: file (audio), preguntaId, audioDurationMs
router.post("/voice-analyze", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    const preguntaId = req.body.preguntaId || "unknown";
    const audioDurationMs = parseInt(req.body.audioDurationMs || "0");

    if (!file) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    console.log(`[Voice] Analyzing audio for pregunta ${preguntaId} (${(file.size / 1024).toFixed(1)}KB, ${audioDurationMs}ms)`);

    // 1. Transcribe with Whisper
    const whisperResult = await transcribirAudio(file.buffer, preguntaId);
    
    // 2. Lexical analysis
    const lexico = analizarLexico(whisperResult.transcript);

    // 3. Voice features from Whisper word timestamps (passive)
    const voiceFeatures = extraerVoiceFeaturesFromWhisper(whisperResult.words, audioDurationMs);

    // 4. Build response
    const features: VoiceFeatures = {
      transcript: whisperResult.transcript,
      confidence: whisperResult.confidence,
      response_time_ms: audioDurationMs,
      ...lexico,
    };

    res.json({
      success: true,
      preguntaId,
      features,
      voice_passive: voiceFeatures,
      whisper_words: whisperResult.words.length,
    });
  } catch (err: any) {
    console.error("[Voice] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== POST /api/evaluacion/completa =====
// Body: { folio_id, datos_financieros, voice_responses: [{pregunta_id, audio_duration_ms, features}] }
router.post("/completa", async (req: Request, res: Response) => {
  try {
    const { folio_id, datos_financieros, voice_responses } = req.body;

    if (!folio_id || !datos_financieros) {
      return res.status(400).json({ error: "Faltan folio_id y datos_financieros" });
    }

    // 1. Run coherencia
    const coherencia = calcularCoherencia(datos_financieros);

    // 2. Aggregate voice features (passive)
    const vr = voice_responses || [];
    let total_muletillas = 0;
    let total_evasion = 0;
    let total_negacion_tajante = 0;
    let total_honestidad = 0;
    let sum_disfluency = 0;
    let sum_honesty = 0;
    const all_flags: string[] = [];

    for (const r of vr) {
      if (r.features) {
        total_muletillas += r.features.muletillas_count || 0;
        total_evasion += r.features.evasion_count || 0;
        total_negacion_tajante += r.features.negacion_tajante_count || 0;
        total_honestidad += r.features.honestidad_count || 0;
        sum_disfluency += r.features.disfluency_rate || 0;
        sum_honesty += r.features.honesty_score || 0;
        if (r.features.lexical_flags) all_flags.push(...r.features.lexical_flags);
      }
    }

    const count = Math.max(1, vr.length);
    const voice_aggregate = {
      total_muletillas,
      total_evasion,
      total_negacion_tajante,
      total_honestidad,
      avg_disfluency_rate: sum_disfluency / count,
      avg_honesty_score: sum_honesty / count,
      voice_flags: Array.from(new Set(all_flags)),
    };

    // 3. Decision: coherencia manda, voice es informativo
    // (En el futuro, voice puede ajustar la decisión)
    const decision_final = coherencia.decision;

    // 4. Save to Neon
    let evalId: number | null = null;
    try {
      evalId = await guardarEvaluacion({
        folio_id,
        datos: datos_financieros,
        coherencia,
        voice_responses: vr,
        voice_aggregate,
      });
    } catch (dbErr: any) {
      console.error("[Evaluación] DB save failed (continuing):", dbErr.message);
    }

    res.json({
      success: true,
      evaluacion_id: evalId,
      folio_id,
      decision: decision_final,
      coherencia,
      voice_aggregate,
      voice_note: "Voice features registrados como datos pasivos. No afectan la decision (aún).",
    });
  } catch (err: any) {
    console.error("[Evaluación] Error completa:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== GET /api/evaluacion/:folioId =====
router.get("/:folioId", async (req: Request, res: Response) => {
  try {
    const eval_data = await obtenerEvaluacion(req.params.folioId as string);
    if (!eval_data) {
      return res.status(404).json({ error: "No hay evaluación para este folio" });
    }
    res.json({ success: true, evaluacion: eval_data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ===== PATCH /api/evaluacion/:folioId/override =====
// Body: { decision: "GO"|"REVIEW"|"NO-GO", motivo: string }
router.patch("/:folioId/override", async (req: Request, res: Response) => {
  try {
    const { decision, motivo } = req.body;
    if (!["GO", "REVIEW", "NO-GO"].includes(decision)) {
      return res.status(400).json({ error: "decision must be GO, REVIEW, or NO-GO" });
    }
    
    const { neon: neonFn } = await import("@neondatabase/serverless");
    const sql = neonFn(process.env.DATABASE_URL!);
    await sql`
      UPDATE evaluaciones_taxi 
      SET override_decision = ${decision}, override_motivo = ${motivo || ""}, updated_at = NOW()
      WHERE folio_id = ${req.params.folioId as string}
    `;
    
    res.json({ success: true, folio_id: req.params.folioId as string, override: decision, motivo });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ===== PATCH /api/evaluacion/:folioId/resultado =====
// Body: { resultado: "al_dia"|"mora"|"fg"|"rescision", meses_al_dia: number }
router.patch("/:folioId/resultado", async (req: Request, res: Response) => {
  try {
    const { resultado, meses_al_dia } = req.body;
    await actualizarResultadoPago(req.params.folioId as string, resultado, meses_al_dia || 0);
    res.json({ success: true, folio_id: req.params.folioId as string, resultado });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ===== POST /api/evaluacion/init-db =====
router.post("/init-db", async (_req: Request, res: Response) => {
  try {
    await crearTablaEvaluaciones();
    res.json({ success: true, message: "Tabla evaluaciones_taxi creada" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
