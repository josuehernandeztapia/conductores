/**
 * Evaluación Rápida Taxi — Wizard de entrevista (Vista Ángeles)
 * 
 * 8 preguntas, una por pantalla. Graba audio, captura números.
 * Ángeles NO ve score, decisión, ni banderas.
 * 
 * Flujo: MicCheck → 8 preguntas → "Evaluación enviada"
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Mic,
  MicOff,
  Square,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Volume2,
  Radio,
  Send,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ===== TYPES =====

interface Pregunta {
  id: string;
  texto: string;
  categoria: string;
  campos: string[];
  peso: number;
  stress_level: number;
  expected_response_time_ms: number;
}

interface RespuestaPregunta {
  pregunta_id: string;
  audio_blob: Blob | null;
  audio_duration_ms: number;
  campos_valores: Record<string, number | boolean | string>;
  transcript: string;
  features: any | null;
  voice_passive: any | null;
}

// Field definitions for numeric inputs per question
const CAMPOS_CONFIG: Record<string, { label: string; placeholder: string; type: "number" | "boolean"; min?: number; max?: number; suffix?: string }[]> = {
  actividad_horario: [
    { label: "Horas al día", placeholder: "Ej: 10", type: "number", min: 1, max: 20, suffix: "hrs" },
    { label: "Días a la semana", placeholder: "Ej: 6", type: "number", min: 1, max: 7, suffix: "días" },
  ],
  servicios_cobro: [
    { label: "Servicios al día", placeholder: "Ej: 15", type: "number", min: 1, max: 50 },
    { label: "Cobro promedio por servicio", placeholder: "Ej: 60", type: "number", min: 10, max: 500, suffix: "$" },
  ],
  ingreso_diario: [
    { label: "Ingreso bruto al día", placeholder: "Ej: 900", type: "number", min: 100, max: 5000, suffix: "$" },
  ],
  estructura_chofer: [
    { label: "¿Tiene chofer?", placeholder: "", type: "boolean" },
    { label: "Cuenta chofer (entrega/día)", placeholder: "Ej: 500", type: "number", min: 0, max: 3000, suffix: "$" },
    { label: "Número de taxis", placeholder: "Ej: 1", type: "number", min: 1, max: 10 },
  ],
  gasto_combustible: [
    { label: "Gasto combustible al día", placeholder: "Ej: 200", type: "number", min: 50, max: 1000, suffix: "$" },
  ],
  gastos_vehiculo: [
    { label: "Mantenimiento mensual", placeholder: "Ej: 1500", type: "number", min: 0, max: 10000, suffix: "$" },
    { label: "Otros gastos vehículo (seguro, verif.)", placeholder: "Ej: 800", type: "number", min: 0, max: 5000, suffix: "$" },
  ],
  carga_financiera: [
    { label: "Otros créditos/pagos mensuales", placeholder: "Ej: 2000", type: "number", min: 0, max: 30000, suffix: "$" },
  ],
  resiliencia: [],
};

const CAMPO_KEYS: Record<string, string[]> = {
  actividad_horario: ["horas_dia", "dias_semana"],
  servicios_cobro: ["servicios_dia", "cobro_promedio_servicio"],
  ingreso_diario: ["ingreso_dia"],
  estructura_chofer: ["tiene_chofer", "cuenta_chofer", "num_taxis"],
  gasto_combustible: ["gasto_combustible_dia"],
  gastos_vehiculo: ["mantenimiento_mes", "otros_gastos_vehiculo"],
  carga_financiera: ["otros_creditos_mes"],
  resiliencia: [],
};

// ===== MIC CHECK COMPONENT =====

function MicCheck({ onReady }: { onReady: () => void }) {
  const [status, setStatus] = useState<"idle" | "requesting" | "testing" | "good" | "bad" | "denied">("idle");
  const [volume, setVolume] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);

  const startTest = useCallback(async () => {
    setStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      setStatus("testing");

      const data = new Uint8Array(analyser.frequencyBinCount);
      let maxVol = 0;
      const startTime = Date.now();

      const check = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        const normalized = Math.min(100, (avg / 128) * 100);
        setVolume(normalized);
        if (normalized > maxVol) maxVol = normalized;

        if (Date.now() - startTime > 3000) {
          // 3 seconds of testing
          stream.getTracks().forEach((t) => t.stop());
          ctx.close();
          if (maxVol > 8) {
            setStatus("good");
          } else {
            setStatus("bad");
          }
          return;
        }
        rafRef.current = requestAnimationFrame(check);
      };
      check();
    } catch (err: any) {
      console.error("Mic permission denied:", err);
      setStatus("denied");
    }
  }, []);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <Card className="max-w-md mx-auto">
      <CardContent className="p-6 space-y-5">
        <div className="text-center space-y-2">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
            {status === "good" ? (
              <CheckCircle2 className="w-8 h-8 text-emerald-500" />
            ) : status === "denied" || status === "bad" ? (
              <MicOff className="w-8 h-8 text-red-500" />
            ) : (
              <Mic className="w-8 h-8 text-primary" />
            )}
          </div>
          <h2 className="text-lg font-semibold">Verificación de Micrófono</h2>
          <p className="text-sm text-muted-foreground">
            {status === "idle" && "Antes de iniciar la entrevista, verifica que el micrófono funcione."}
            {status === "requesting" && "Autorizando acceso al micrófono..."}
            {status === "testing" && "Habla para probar — di tu nombre completo."}
            {status === "good" && "Micrófono listo. El audio se escucha bien."}
            {status === "bad" && "No se detectó audio suficiente. Acércate más o busca un lugar más tranquilo."}
            {status === "denied" && "Se necesita permiso de micrófono. Actívalo en la configuración del navegador."}
          </p>
        </div>

        {status === "testing" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-muted-foreground" />
              <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-100 rounded-full"
                  style={{ width: `${volume}%` }}
                />
              </div>
              <Radio className="w-4 h-4 text-red-500 animate-pulse" />
            </div>
            <p className="text-[10px] text-center text-muted-foreground">Grabando prueba de audio (3 seg)...</p>
          </div>
        )}

        <div className="flex justify-center">
          {(status === "idle" || status === "bad" || status === "denied") && (
            <Button onClick={startTest} data-testid="button-mic-test">
              <Mic className="w-4 h-4 mr-2" />
              {status === "idle" ? "Probar Micrófono" : "Reintentar"}
            </Button>
          )}
          {status === "requesting" && (
            <Button disabled>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Solicitando acceso...
            </Button>
          )}
          {status === "good" && (
            <Button onClick={onReady} data-testid="button-start-interview">
              Iniciar Entrevista
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ===== AUDIO RECORDER HOOK =====

function useAudioRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const startTimeRef = useRef(0);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.start(250);
      mediaRecorderRef.current = mr;
      startTimeRef.current = Date.now();
      setIsRecording(true);
      setDuration(0);
      timerRef.current = setInterval(() => {
        setDuration(Date.now() - startTimeRef.current);
      }, 200);
    } catch (err) {
      console.error("Record error:", err);
    }
  }, []);

  const stop = useCallback((): Promise<{ blob: Blob; durationMs: number }> => {
    return new Promise((resolve) => {
      const mr = mediaRecorderRef.current;
      if (!mr || mr.state === "inactive") {
        resolve({ blob: new Blob(), durationMs: 0 });
        return;
      }
      const finalDuration = Date.now() - startTimeRef.current;
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        mr.stream.getTracks().forEach((t) => t.stop());
        setIsRecording(false);
        clearInterval(timerRef.current);
        setDuration(finalDuration);
        resolve({ blob, durationMs: finalDuration });
      };
      mr.stop();
    });
  }, []);

  useEffect(() => {
    return () => {
      clearInterval(timerRef.current);
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  return { isRecording, duration, start, stop };
}

// ===== QUESTION STEP COMPONENT =====

function PreguntaStep({
  pregunta,
  stepNum,
  totalSteps,
  respuesta,
  onUpdateRespuesta,
  onNext,
  onBack,
  isAnalyzing,
}: {
  pregunta: Pregunta;
  stepNum: number;
  totalSteps: number;
  respuesta: RespuestaPregunta;
  onUpdateRespuesta: (r: Partial<RespuestaPregunta>) => void;
  onNext: () => void;
  onBack: () => void;
  isAnalyzing: boolean;
}) {
  const { isRecording, duration, start, stop } = useAudioRecorder();
  const campos = CAMPOS_CONFIG[pregunta.id] || [];
  const campoKeys = CAMPO_KEYS[pregunta.id] || [];
  const hasAudio = respuesta.audio_blob !== null;

  const handleStopRecording = async () => {
    const { blob, durationMs } = await stop();
    onUpdateRespuesta({ audio_blob: blob, audio_duration_ms: durationMs });
  };

  const formatDuration = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  };

  // Check if all required numeric fields have values
  const allFieldsFilled = campos.length === 0 || campos.every((c, i) => {
    const key = campoKeys[i];
    const val = respuesta.campos_valores[key];
    if (c.type === "boolean") return val !== undefined;
    return val !== undefined && val !== "" && val !== 0;
  });

  // Resiliencia (last question) only needs audio
  const canAdvance = pregunta.id === "resiliencia"
    ? hasAudio
    : hasAudio && allFieldsFilled;

  // Range validation warning
  const getRangeWarning = (campoConfig: typeof campos[0], value: number): string | null => {
    if (campoConfig.min !== undefined && value < campoConfig.min) return `Mínimo esperado: ${campoConfig.min}`;
    if (campoConfig.max !== undefined && value > campoConfig.max) return `Máximo esperado: ${campoConfig.max}. ¿Es correcto?`;
    return null;
  };

  return (
    <div className="max-w-md mx-auto space-y-4">
      {/* Progress */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Pregunta {stepNum} de {totalSteps}</span>
          <span>{Math.round((stepNum / totalSteps) * 100)}%</span>
        </div>
        <Progress value={(stepNum / totalSteps) * 100} className="h-1.5" />
      </div>

      {/* Category badge */}
      <Badge variant="outline" className="text-[10px]">
        {pregunta.categoria.replace(/_/g, " ").toUpperCase()}
      </Badge>

      {/* Question */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <h3 className="text-base font-semibold leading-snug" data-testid="text-question">
            {pregunta.texto}
          </h3>

          {/* Audio recording */}
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              {!isRecording && !hasAudio && (
                <Button
                  onClick={start}
                  variant="default"
                  size="lg"
                  className="flex-1"
                  data-testid="button-record-start"
                >
                  <Mic className="w-5 h-5 mr-2" />
                  Grabar Respuesta
                </Button>
              )}
              {isRecording && (
                <Button
                  onClick={handleStopRecording}
                  variant="destructive"
                  size="lg"
                  className="flex-1 animate-pulse"
                  data-testid="button-record-stop"
                >
                  <Square className="w-4 h-4 mr-2" />
                  Detener · {formatDuration(duration)}
                </Button>
              )}
              {hasAudio && !isRecording && (
                <div className="flex items-center gap-2 flex-1">
                  <Badge variant="secondary" className="text-xs bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                    <CheckCircle2 className="w-3 h-3 mr-1" />
                    Audio grabado · {formatDuration(respuesta.audio_duration_ms)}
                  </Badge>
                  <Button
                    onClick={start}
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    data-testid="button-record-redo"
                  >
                    Regrabar
                  </Button>
                </div>
              )}
            </div>
            {isRecording && (
              <div className="flex items-center gap-1.5">
                <Radio className="w-3 h-3 text-red-500 animate-pulse" />
                <span className="text-[10px] text-red-500 font-medium">Grabando...</span>
              </div>
            )}
            {isAnalyzing && (
              <div className="flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin text-blue-500" />
                <span className="text-[10px] text-blue-500">Procesando audio...</span>
              </div>
            )}
          </div>

          {/* Numeric fields */}
          {campos.length > 0 && (
            <div className="space-y-3 pt-2 border-t">
              <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                Confirma los datos
              </p>
              {campos.map((campo, i) => {
                const key = campoKeys[i];
                const value = respuesta.campos_valores[key];

                if (campo.type === "boolean") {
                  return (
                    <div key={key} className="flex items-center gap-3">
                      <span className="text-sm flex-1">{campo.label}</span>
                      <div className="flex gap-2">
                        <Button
                          variant={value === true ? "default" : "outline"}
                          size="sm"
                          onClick={() => onUpdateRespuesta({
                            campos_valores: { ...respuesta.campos_valores, [key]: true },
                          })}
                          data-testid={`button-${key}-yes`}
                        >
                          Sí
                        </Button>
                        <Button
                          variant={value === false ? "default" : "outline"}
                          size="sm"
                          onClick={() => onUpdateRespuesta({
                            campos_valores: { ...respuesta.campos_valores, [key]: false, cuenta_chofer: 0 },
                          })}
                          data-testid={`button-${key}-no`}
                        >
                          No
                        </Button>
                      </div>
                    </div>
                  );
                }

                // Skip cuenta_chofer if no chofer
                if (key === "cuenta_chofer" && respuesta.campos_valores["tiene_chofer"] === false) {
                  return null;
                }

                const numVal = typeof value === "number" ? value : 0;
                const warning = numVal > 0 ? getRangeWarning(campo, numVal) : null;

                return (
                  <div key={key} className="space-y-1">
                    <label className="text-sm font-medium">{campo.label}</label>
                    <div className="flex items-center gap-2">
                      {campo.suffix === "$" && <span className="text-sm text-muted-foreground">$</span>}
                      <Input
                        type="number"
                        placeholder={campo.placeholder}
                        value={value !== undefined && value !== 0 ? String(value) : ""}
                        onChange={(e) => {
                          const v = e.target.value === "" ? 0 : parseFloat(e.target.value);
                          onUpdateRespuesta({
                            campos_valores: { ...respuesta.campos_valores, [key]: v },
                          });
                        }}
                        className="flex-1"
                        data-testid={`input-${key}`}
                      />
                      {campo.suffix && campo.suffix !== "$" && (
                        <span className="text-sm text-muted-foreground">{campo.suffix}</span>
                      )}
                    </div>
                    {warning && (
                      <div className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="w-3 h-3" />
                        <span>{warning}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Resiliencia: no fields, just audio */}
          {pregunta.id === "resiliencia" && (
            <p className="text-xs text-muted-foreground italic">
              Solo se requiere la grabación de audio para esta pregunta.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Navigation */}
      <div className="flex items-center justify-between pt-2">
        <Button
          variant="ghost"
          onClick={onBack}
          disabled={stepNum === 1}
          data-testid="button-prev"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Anterior
        </Button>
        <Button
          onClick={onNext}
          disabled={!canAdvance || isAnalyzing}
          data-testid="button-next"
        >
          {isAnalyzing ? (
            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
          ) : stepNum === totalSteps ? (
            <Send className="w-4 h-4 mr-1" />
          ) : (
            <ArrowRight className="w-4 h-4 mr-1" />
          )}
          {stepNum === totalSteps ? "Enviar Evaluación" : "Siguiente"}
        </Button>
      </div>
    </div>
  );
}

// ===== MAIN WIZARD =====

const API_BASE = "";

export default function EvaluacionWizard({
  folioId,
  cuotaCmuMensual,
  onComplete,
  onBack,
}: {
  folioId: string;
  cuotaCmuMensual: number;
  onComplete: () => void;
  onBack: () => void;
}) {
  const [phase, setPhase] = useState<"mic-check" | "interview" | "submitting" | "done">("mic-check");
  const [preguntas, setPreguntas] = useState<Pregunta[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [respuestas, setRespuestas] = useState<RespuestaPregunta[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const { toast } = useToast();

  // Load questions from backend
  useEffect(() => {
    fetch(`${API_BASE}/api/evaluacion/preguntas`)
      .then((r) => r.json())
      .then((data) => {
        const qs: Pregunta[] = data.preguntas;
        setPreguntas(qs);
        setRespuestas(
          qs.map((q) => ({
            pregunta_id: q.id,
            audio_blob: null,
            audio_duration_ms: 0,
            campos_valores: {},
            transcript: "",
            features: null,
            voice_passive: null,
          }))
        );
      })
      .catch((err) => {
        console.error("Failed to load preguntas:", err);
        toast({ title: "Error", description: "No se pudieron cargar las preguntas", variant: "destructive" });
      });
  }, []);

  const updateRespuesta = (index: number, partial: Partial<RespuestaPregunta>) => {
    setRespuestas((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...partial };
      return next;
    });
  };

  // Send audio to backend for analysis when moving to next question
  const analyzeAudio = async (index: number): Promise<void> => {
    const r = respuestas[index];
    if (!r.audio_blob || r.audio_blob.size === 0) return;

    setIsAnalyzing(true);
    try {
      const form = new FormData();
      form.append("file", r.audio_blob, `eval-${r.pregunta_id}.webm`);
      form.append("preguntaId", r.pregunta_id);
      form.append("audioDurationMs", String(r.audio_duration_ms));

      const resp = await fetch(`${API_BASE}/api/evaluacion/voice-analyze`, {
        method: "POST",
        body: form,
      });
      const data = await resp.json();

      if (data.success) {
        updateRespuesta(index, {
          transcript: data.features.transcript,
          features: data.features,
          voice_passive: data.voice_passive,
        });
      }
    } catch (err) {
      console.error("Voice analyze error:", err);
      // Non-blocking — if Whisper fails, we continue with just the numeric data
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleNext = async () => {
    // Analyze current audio
    await analyzeAudio(currentStep);

    if (currentStep < preguntas.length - 1) {
      setCurrentStep((s) => s + 1);
    } else {
      // Submit complete evaluation
      await submitEvaluation();
    }
  };

  const handlePrev = () => {
    if (currentStep > 0) setCurrentStep((s) => s - 1);
  };

  const submitEvaluation = async () => {
    setPhase("submitting");
    try {
      // Build datos_financieros from all respuestas
      const allCampos: Record<string, any> = {};
      for (const r of respuestas) {
        Object.assign(allCampos, r.campos_valores);
      }

      const datos_financieros = {
        horas_dia: Number(allCampos.horas_dia) || 0,
        dias_semana: Number(allCampos.dias_semana) || 0,
        servicios_dia: Number(allCampos.servicios_dia) || 0,
        cobro_promedio_servicio: Number(allCampos.cobro_promedio_servicio) || 0,
        ingreso_dia: Number(allCampos.ingreso_dia) || 0,
        tiene_chofer: allCampos.tiene_chofer === true,
        cuenta_chofer: Number(allCampos.cuenta_chofer) || 0,
        num_taxis: Number(allCampos.num_taxis) || 1,
        gasto_combustible_dia: Number(allCampos.gasto_combustible_dia) || 0,
        mantenimiento_mes: Number(allCampos.mantenimiento_mes) || 0,
        otros_gastos_vehiculo: Number(allCampos.otros_gastos_vehiculo) || 0,
        otros_creditos_mes: Number(allCampos.otros_creditos_mes) || 0,
        cuota_cmu_mensual: cuotaCmuMensual,
      };

      const voice_responses = respuestas.map((r) => ({
        pregunta_id: r.pregunta_id,
        audio_duration_ms: r.audio_duration_ms,
        features: r.features,
        voice_passive: r.voice_passive,
      }));

      const resp = await fetch(`${API_BASE}/api/evaluacion/completa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folio_id: folioId,
          datos_financieros,
          voice_responses,
        }),
      });

      const data = await resp.json();

      if (data.success) {
        setPhase("done");
        toast({ title: "Evaluación enviada", description: "Josué la revisará." });
      } else {
        throw new Error(data.error || "Error al enviar");
      }
    } catch (err: any) {
      console.error("Submit error:", err);
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setPhase("interview");
    }
  };

  // ===== RENDER =====

  if (phase === "mic-check") {
    return <MicCheck onReady={() => setPhase("interview")} />;
  }

  if (phase === "submitting") {
    return (
      <Card className="max-w-md mx-auto">
        <CardContent className="p-8 text-center space-y-4">
          <Loader2 className="w-10 h-10 animate-spin mx-auto text-primary" />
          <h3 className="text-lg font-semibold">Enviando evaluación...</h3>
          <p className="text-sm text-muted-foreground">Procesando datos y análisis de voz.</p>
        </CardContent>
      </Card>
    );
  }

  if (phase === "done") {
    return (
      <Card className="max-w-md mx-auto">
        <CardContent className="p-8 text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-8 h-8 text-emerald-500" />
          </div>
          <h3 className="text-lg font-semibold">Evaluación Enviada</h3>
          <p className="text-sm text-muted-foreground">
            La evaluación del folio <strong>{folioId}</strong> fue enviada correctamente.
            Josué la revisará y te notificará el resultado.
          </p>
          <Button onClick={onComplete} data-testid="button-eval-done">
            Continuar
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (preguntas.length === 0) {
    return (
      <Card className="max-w-md mx-auto">
        <CardContent className="p-8 text-center">
          <Loader2 className="w-8 h-8 animate-spin mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground mt-3">Cargando preguntas...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <PreguntaStep
      pregunta={preguntas[currentStep]}
      stepNum={currentStep + 1}
      totalSteps={preguntas.length}
      respuesta={respuestas[currentStep]}
      onUpdateRespuesta={(partial) => updateRespuesta(currentStep, partial)}
      onNext={handleNext}
      onBack={handlePrev}
      isAnalyzing={isAnalyzing}
    />
  );
}
