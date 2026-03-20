import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CheckCircle2,
  Circle,
  FileText,
  Loader2,
  Phone,
  Upload,
  Download,
  Shield,
  X,
  Eye,
  FileImage,
  Lock,
  ImageIcon,
  RotateCcw,
  User,
  ScanFace,
  Sparkles,
  AlertTriangle,
  Edit3,
  Car,
  Save,
} from "lucide-react";
import { useState, useCallback, useRef, useEffect } from "react";
import { Link, useParams } from "wouter";
import { useToast } from "@/hooks/use-toast";
import type { Origination, Document as DocType } from "@shared/schema";
import { ORIGINATION_STEPS, DOCUMENT_TYPES, type DocumentType } from "@shared/schema";
import {
  subscribe,
  apiGetOrigination,
  apiUpdateOrigination,
  apiGetDocuments,
  apiSaveDocument,
  apiRunOcr,
  apiSendOtp,
  apiVerifyOtp,
  getTaxista,
} from "@/lib/api";
import { getVehicle } from "@/lib/storage";
import {
  generateConvenioValidacion,
  generateContratoCompraventa,
} from "@/lib/contract-pdf";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-MX", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ===== Document definitions for Step 2 wizard =====
interface CaptureDocDef {
  key: string;
  label: string;
  instructions: string;
  icon: typeof FileText;
  profileFilter?: "A"; // if set, only show for this profile
  isBiometric?: boolean;
}

const CAPTURE_DOCUMENTS: CaptureDocDef[] = [
  {
    key: "ine_frente",
    label: "INE Frente",
    icon: User,
    instructions: "Coloca tu INE sobre una superficie plana con buena iluminación. Asegúrate de que los 4 bordes sean visibles.",
  },
  {
    key: "ine_reverso",
    label: "INE Reverso",
    icon: User,
    instructions: "Voltea la INE y captura el reverso. Verifica que el código de barras sea legible.",
  },
  {
    key: "csf",
    label: "Constancia de Situación Fiscal",
    icon: FileText,
    instructions: "Captura la Constancia de Situación Fiscal (CSF) del SAT. El RFC y régimen fiscal deben ser legibles.",
  },
  {
    key: "comprobante_domicilio",
    label: "Comprobante de Domicilio",
    icon: FileText,
    instructions: "Recibo de luz, agua o teléfono de los últimos 3 meses. La dirección completa debe ser visible.",
  },
  {
    key: "concesion",
    label: "Concesión de Taxi",
    icon: FileText,
    instructions: "Fotografía la concesión de taxi vigente. El número de concesión y titular deben ser claros.",
  },
  {
    key: "estado_cuenta",
    label: "Estado de Cuenta Bancario",
    icon: FileText,
    instructions: "Estado de cuenta bancario reciente. La CLABE interbancaria y nombre del titular deben ser visibles.",
  },
  {
    key: "historial_gnv",
    label: "Historial de Consumo GNV",
    icon: FileText,
    instructions: "Comprobante de consumo de gas natural vehicular. Debe mostrar el promedio mensual en LEQ.",
    profileFilter: "A",
  },
  {
    key: "factura_vehiculo",
    label: "Factura del Vehículo",
    icon: FileText,
    instructions: "Factura original del vehículo. Marca, modelo, año, número de serie y NIV deben ser legibles.",
  },
  {
    key: "carta_membresia",
    label: "Carta de Membresía",
    icon: FileText,
    instructions: "Carta de membresía de la central de taxistas. Número de membresía y vigencia visibles.",
    profileFilter: "A",
  },
  {
    key: "selfie_biometrico",
    label: "Selfie Biométrico",
    icon: ScanFace,
    instructions: "Toma una selfie con la cámara frontal. Centra tu rostro dentro del óvalo. Buena iluminación, sin lentes ni gorras.",
    isBiometric: true,
  },
];

// Simulated OCR templates
const OCR_TEMPLATES: Record<string, Record<string, string>> = {
  ine_frente: { nombre: "", apellidos: "", curp: "", clave_elector: "", seccion: "", vigencia: "" },
  ine_reverso: { direccion: "", codigo_postal: "", seccion: "", emision: "" },
  csf: { rfc: "", razon_social: "", regimen_fiscal: "", domicilio_fiscal: "" },
  comprobante_domicilio: { direccion: "", tipo: "", fecha: "" },
  concesion: { numero_concesion: "", titular: "", vigencia: "", ruta: "" },
  estado_cuenta: { banco: "", clabe: "", titular: "" },
  historial_gnv: { tipo: "GNV", promedio_mensual: "", meses: "" },
  factura_vehiculo: { marca: "", modelo: "", anio: "", num_serie: "", niv: "", propietario: "" },
  carta_membresia: { numero: "", titular: "", vigencia: "" },
  selfie_biometrico: { validacion: "pendiente", similitud: "" },
};

// ===== Biometric Selfie Capture with Oval Guide =====
function BiometricCapture({
  onCapture,
  isAnalyzing,
}: {
  onCapture: (file: File) => void;
  isAnalyzing: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const startCamera = useCallback(async () => {
    try {
      setCameraError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      setCameraActive(true);
    } catch (err: any) {
      setCameraError(
        err.name === "NotAllowedError"
          ? "Permiso de cámara denegado. Habilita el acceso a la cámara en tu navegador."
          : err.name === "NotFoundError"
          ? "No se detectó cámara frontal. Usa el botón de galería para subir una foto."
          : `Error de cámara: ${err.message}. Intenta subir una foto desde galería.`
      );
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  }, []);

  useEffect(() => {
    return () => { stopCamera(); };
  }, [stopCamera]);

  const takePhoto = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Mirror the image (selfie mode)
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) {
          const file = new File([blob], "selfie_biometrico.jpg", { type: "image/jpeg" });
          stopCamera();
          onCapture(file);
        }
      },
      "image/jpeg",
      0.9
    );
  }, [onCapture, stopCamera]);

  return (
    <div className="space-y-3">
      <canvas ref={canvasRef} className="hidden" />

      {/* Hidden file input as fallback */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="user"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onCapture(file);
          e.target.value = "";
        }}
        data-testid="wizard-selfie-file-input"
      />

      {cameraActive ? (
        <div className="relative w-full aspect-[3/4] max-h-[400px] rounded-2xl overflow-hidden bg-black">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
            style={{ transform: "scaleX(-1)" }}
          />
          {/* Oval Guide Overlay */}
          <div className="absolute inset-0 pointer-events-none">
            <svg width="100%" height="100%" viewBox="0 0 300 400" preserveAspectRatio="xMidYMid slice">
              <defs>
                <mask id="oval-mask">
                  <rect width="300" height="400" fill="white" />
                  <ellipse cx="150" cy="175" rx="90" ry="120" fill="black" />
                </mask>
              </defs>
              <rect width="300" height="400" fill="rgba(0,0,0,0.55)" mask="url(#oval-mask)" />
              <ellipse cx="150" cy="175" rx="90" ry="120" fill="none" stroke="white" strokeWidth="2.5" strokeDasharray="8 4" opacity="0.8" />
            </svg>
          </div>
          {/* Instruction overlay */}
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 pt-8">
            <p className="text-white text-xs text-center font-medium">
              Centra tu rostro dentro del óvalo
            </p>
          </div>
        </div>
      ) : (
        <div className="relative w-full aspect-[3/4] max-h-[400px] rounded-2xl overflow-hidden bg-muted/30 border-2 border-dashed border-border flex flex-col items-center justify-center gap-4">
          {/* Static oval guide preview */}
          <div className="absolute inset-0 flex items-center justify-center opacity-10">
            <svg width="180" height="240" viewBox="0 0 180 240">
              <ellipse cx="90" cy="105" rx="70" ry="90" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="8 4" />
            </svg>
          </div>
          <ScanFace className="w-16 h-16 text-muted-foreground/40" />
          <div className="text-center px-6 z-10">
            <p className="text-sm font-medium text-foreground/80 mb-1">Captura biométrica</p>
            <p className="text-xs text-muted-foreground">Se usará la cámara frontal para verificar la identidad del taxista</p>
          </div>
        </div>
      )}

      {cameraError && (
        <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
          <p className="text-xs text-amber-700 dark:text-amber-400">{cameraError}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {cameraActive ? (
          <>
            <Button
              className="gap-2 h-14 flex-col"
              onClick={takePhoto}
              disabled={isAnalyzing}
              data-testid="wizard-btn-take-selfie"
            >
              <Camera className="w-5 h-5" />
              <span className="text-xs">Capturar</span>
            </Button>
            <Button
              variant="outline"
              className="gap-2 h-14 flex-col"
              onClick={stopCamera}
              data-testid="wizard-btn-stop-camera"
            >
              <X className="w-5 h-5" />
              <span className="text-xs">Cancelar</span>
            </Button>
          </>
        ) : (
          <>
            <Button
              className="gap-2 h-14 flex-col"
              onClick={startCamera}
              disabled={isAnalyzing}
              data-testid="wizard-btn-start-camera"
            >
              <Camera className="w-5 h-5" />
              <span className="text-xs">Abrir Cámara</span>
            </Button>
            <Button
              variant="outline"
              className="gap-2 h-14 flex-col"
              onClick={() => fileInputRef.current?.click()}
              disabled={isAnalyzing}
              data-testid="wizard-btn-selfie-gallery"
            >
              <FileImage className="w-5 h-5" />
              <span className="text-xs">Subir Foto</span>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ===== Step 2: One-by-one Document Wizard (Enhanced) =====
function DocumentWizard({
  origination,
  docs,
  onAllCaptured,
  refreshAll,
}: {
  origination: Origination;
  docs: DocType[];
  onAllCaptured: () => void;
  refreshAll: () => void;
}) {
  const { toast } = useToast();

  // Filter document list based on profile
  const captureList = CAPTURE_DOCUMENTS.filter((doc) => {
    if (doc.profileFilter && doc.profileFilter !== origination.perfilTipo) return false;
    return true;
  });

  const totalDocs = captureList.length;

  const [currentIdx, setCurrentIdx] = useState(0);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    docs.forEach((d) => {
      if (d.imageData) initial[d.tipo] = d.imageData;
    });
    return initial;
  });
  // OCR confidence per doc: green=alta, yellow=media, red=baja
  const [ocrConfidences, setOcrConfidences] = useState<Record<string, "alta" | "media" | "baja">>(() => {
    const initial: Record<string, "alta" | "media" | "baja"> = {};
    docs.forEach((d) => {
      if (d.ocrConfidence) initial[d.tipo] = d.ocrConfidence as "alta" | "media" | "baja";
    });
    return initial;
  });
  const [slideDirection, setSlideDirection] = useState<"left" | "right">("right");

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  const currentDoc = captureList[currentIdx];
  const currentPreview = previews[currentDoc?.key] || null;
  const isCurrentCaptured = !!currentPreview;
  const capturedCount = captureList.filter((d) => !!previews[d.key]).length;

  // Check if a doc key was already captured (from docs list)
  const getDocStatus = (key: string): "pending" | "captured" | "verified" => {
    if (previews[key]) {
      const existingDoc = docs.find((d) => d.tipo === key);
      if (existingDoc?.status === "verified") return "verified";
      return "captured";
    }
    return "pending";
  };

  // OCR confidence color helper
  const getConfidenceColor = (key: string) => {
    const conf = ocrConfidences[key];
    if (!conf) return null;
    if (conf === "alta") return { bg: "bg-emerald-500", ring: "ring-emerald-400", text: "text-emerald-700", label: "Alta" };
    if (conf === "media") return { bg: "bg-amber-500", ring: "ring-amber-400", text: "text-amber-700", label: "Media" };
    return { bg: "bg-red-500", ring: "ring-red-400", text: "text-red-700", label: "Baja" };
  };

  const handleFile = useCallback(async (file: File) => {
    if (!currentDoc) return;
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "Archivo muy grande", description: "Máximo 10MB", variant: "destructive" });
      return;
    }

    setIsCapturing(true);
    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target?.result as string;
      setIsCapturing(false);
      setIsAnalyzing(true);

      // Update preview immediately
      setPreviews((prev) => ({ ...prev, [currentDoc.key]: dataUrl }));

      try {
        // For biometric selfie, just save directly (no OCR needed)
        if (currentDoc.isBiometric) {
          await apiSaveDocument({
            originationId: origination.id,
            tipo: currentDoc.key,
            imageData: dataUrl,
            ocrResult: JSON.stringify({ validacion: "capturado" }),
            ocrConfidence: "alta",
            editedData: JSON.stringify({ validacion: "capturado" }),
            status: "ocr_done",
          });
          setOcrConfidences((prev) => ({ ...prev, [currentDoc.key]: "alta" }));
          toast({ title: "Selfie capturado", description: "Imagen biométrica guardada" });
        } else {
          // Real OCR via Claude Vision
          const ocrResult = await apiRunOcr({
            originationId: origination.id,
            docType: currentDoc.key,
            imageData: dataUrl,
          });

          const conf = ocrResult.confidence;
          setOcrConfidences((prev) => ({ ...prev, [currentDoc.key]: conf }));

          const confLabels = { alta: "alta", media: "media", baja: "baja" };
          const confColors = { alta: "emerald", media: "amber", baja: "red" };
          toast({
            title: conf === "alta" ? "Documento procesado" : conf === "media" ? "Documento procesado (verificar)" : "Documento con lectura débil",
            description: `${currentDoc.label} — confianza ${confLabels[conf]}`,
            variant: conf === "baja" ? "destructive" : undefined,
          });
        }

        refreshAll();

        // Auto-advance after 600ms if not last document
        if (currentIdx < totalDocs - 1) {
          setTimeout(() => {
            setSlideDirection("right");
            setCurrentIdx((i) => i + 1);
          }, 600);
        }
      } catch (err: any) {
        toast({ title: "Error", description: err.message || "No se pudo guardar", variant: "destructive" });
      } finally {
        setIsAnalyzing(false);
      }
    };
    reader.readAsDataURL(file);
  }, [currentDoc, origination.id, toast, refreshAll, currentIdx, totalDocs]);

  const handleNext = () => {
    if (currentIdx < totalDocs - 1) {
      setSlideDirection("right");
      setCurrentIdx((i) => i + 1);
    } else {
      // All documents captured — advance to step 3
      onAllCaptured();
    }
  };

  const handlePrev = () => {
    if (currentIdx > 0) {
      setSlideDirection("left");
      setCurrentIdx((i) => i - 1);
    }
  };

  if (!currentDoc) return null;

  const isBiometric = !!currentDoc.isBiometric;
  const DocIcon = currentDoc.icon;
  const progressPercent = Math.round((capturedCount / totalDocs) * 100);

  return (
    <div className="space-y-4">
      {/* Progress header */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-muted-foreground">
            {capturedCount} de {totalDocs} documentos
          </span>
          <span className="font-bold text-primary tabular-nums">{progressPercent}%</span>
        </div>
        <Progress value={progressPercent} className="h-2" />
      </div>

      {/* Status indicator circles with OCR confidence colors */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {captureList.map((doc, idx) => {
          const status = getDocStatus(doc.key);
          const confColor = getConfidenceColor(doc.key);
          return (
            <button
              key={doc.key}
              onClick={() => {
                setSlideDirection(idx > currentIdx ? "right" : "left");
                setCurrentIdx(idx);
              }}
              title={`${doc.label}${confColor ? ` — Confianza ${confColor.label}` : ""}`}
              className={`w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-bold transition-all duration-200 border-2 ${
                idx === currentIdx
                  ? "border-primary ring-2 ring-primary/20 scale-110"
                  : "border-transparent"
              } ${
                status === "verified" || status === "captured"
                  ? confColor
                    ? `${confColor.bg} text-white`
                    : "bg-emerald-400 text-white"
                  : "bg-muted text-muted-foreground"
              }`}
              data-testid={`wizard-dot-${doc.key}`}
            >
              {status === "verified" || status === "captured" ? (
                confColor && confColor.bg.includes("red") ? (
                  <AlertTriangle className="w-3.5 h-3.5" />
                ) : confColor && confColor.bg.includes("amber") ? (
                  <AlertTriangle className="w-3.5 h-3.5" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                )
              ) : (
                idx + 1
              )}
            </button>
          );
        })}
      </div>

      {/* Document card with slide animation */}
      <div
        key={currentDoc.key}
        className="animate-in fade-in slide-in-from-right-4 duration-200"
        style={{
          animationName: slideDirection === "right" ? "slide-in-right" : "slide-in-left",
        }}
      >
        <Card className="border-2 overflow-hidden">
          {/* Card header with doc type icon */}
          <div className={`px-5 py-3 flex items-center gap-3 border-b ${
            isBiometric
              ? "bg-gradient-to-r from-violet-50 to-indigo-50 dark:from-violet-950/30 dark:to-indigo-950/30 border-violet-200 dark:border-violet-800"
              : "bg-muted/30"
          }`}>
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${
              isBiometric
                ? "bg-violet-100 dark:bg-violet-900/50"
                : "bg-primary/10"
            }`}>
              <DocIcon className={`w-5 h-5 ${isBiometric ? "text-violet-600 dark:text-violet-400" : "text-primary"}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground font-medium">
                  {currentIdx + 1} / {totalDocs}
                </span>
                {isCurrentCaptured && (() => {
                  const cc = getConfidenceColor(currentDoc.key);
                  if (cc && cc.bg.includes("red")) return (
                    <Badge className="text-[10px] bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 border-red-300 dark:border-red-700">
                      <AlertTriangle className="w-3 h-3 mr-1" />
                      Baja
                    </Badge>
                  );
                  if (cc && cc.bg.includes("amber")) return (
                    <Badge className="text-[10px] bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 border-amber-300 dark:border-amber-700">
                      <AlertTriangle className="w-3 h-3 mr-1" />
                      Media
                    </Badge>
                  );
                  return (
                    <Badge className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700">
                      <CheckCircle2 className="w-3 h-3 mr-1" />
                      Alta
                    </Badge>
                  );
                })()}
              </div>
              <h2 className="text-base font-bold leading-tight truncate">{currentDoc.label}</h2>
            </div>
          </div>

          <CardContent className="p-5 space-y-4">
            {/* Instructions */}
            <p className="text-sm text-muted-foreground leading-relaxed">
              {currentDoc.instructions}
            </p>

            {/* Biometric-specific capture */}
            {isBiometric && !currentPreview ? (
              <BiometricCapture
                onCapture={(file) => handleFile(file)}
                isAnalyzing={isAnalyzing}
              />
            ) : (
              <>
                {/* Hidden inputs for regular document capture */}
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFile(file);
                    e.target.value = "";
                  }}
                  data-testid={`wizard-camera-${currentDoc.key}`}
                />
                <input
                  ref={galleryInputRef}
                  type="file"
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFile(file);
                    e.target.value = "";
                  }}
                  data-testid={`wizard-gallery-${currentDoc.key}`}
                />

                {/* Preview or capture area */}
                {currentPreview ? (
                  <div className="space-y-3">
                    <div className={`relative w-full rounded-xl overflow-hidden border border-border bg-muted ${
                      isBiometric ? "aspect-[3/4] max-h-[400px]" : "aspect-[4/3]"
                    }`}>
                      <img
                        src={currentPreview}
                        alt={currentDoc.label}
                        className="w-full h-full object-contain"
                      />
                      {isAnalyzing && (
                        <div className="absolute inset-0 bg-black/60 flex items-center justify-center rounded-xl backdrop-blur-sm">
                          <div className="text-center text-white space-y-2">
                            <div className="relative">
                              <Loader2 className="w-10 h-10 animate-spin mx-auto" />
                              <Sparkles className="w-4 h-4 absolute -top-1 -right-1 text-amber-400 animate-pulse" />
                            </div>
                            <p className="text-sm font-medium">Analizando documento...</p>
                            <p className="text-xs text-white/60">Extrayendo datos automáticamente</p>
                          </div>
                        </div>
                      )}
                      {/* Success overlay for captured docs */}
                      {isCurrentCaptured && !isAnalyzing && (
                        <div className="absolute top-3 right-3">
                          <div className="bg-emerald-500 text-white rounded-full p-1.5 shadow-lg">
                            <CheckCircle2 className="w-4 h-4" />
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Retake button */}
                    <Button
                      variant="outline"
                      className="w-full gap-2"
                      onClick={() => {
                        if (isBiometric) {
                          // Clear preview and let biometric component handle it
                          setPreviews((prev) => {
                            const next = { ...prev };
                            delete next[currentDoc.key];
                            return next;
                          });
                        } else {
                          cameraInputRef.current?.click();
                        }
                      }}
                      disabled={isAnalyzing}
                      data-testid={`wizard-retake-${currentDoc.key}`}
                    >
                      <RotateCcw className="w-4 h-4" />
                      Retomar foto
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {/* Capture placeholder */}
                    <div className="w-full aspect-[4/3] rounded-xl border-2 border-dashed border-border bg-muted/20 flex flex-col items-center justify-center gap-3 transition-colors hover:border-primary/30 hover:bg-muted/30">
                      {isCapturing ? (
                        <>
                          <Loader2 className="w-10 h-10 text-muted-foreground animate-spin" />
                          <p className="text-sm text-muted-foreground">Cargando...</p>
                        </>
                      ) : (
                        <>
                          <ImageIcon className="w-14 h-14 text-muted-foreground/30" />
                          <p className="text-sm text-muted-foreground text-center px-4">
                            Captura o sube este documento
                          </p>
                        </>
                      )}
                    </div>

                    {/* Capture buttons */}
                    <div className="grid grid-cols-2 gap-3">
                      <Button
                        className="gap-2 h-14 text-sm font-semibold flex-col"
                        onClick={() => cameraInputRef.current?.click()}
                        disabled={isCapturing || isAnalyzing}
                        data-testid={`wizard-btn-camera-${currentDoc.key}`}
                      >
                        <Camera className="w-5 h-5" />
                        <span className="text-xs">Tomar Foto</span>
                      </Button>
                      <Button
                        variant="outline"
                        className="gap-2 h-14 text-sm font-semibold flex-col"
                        onClick={() => galleryInputRef.current?.click()}
                        disabled={isCapturing || isAnalyzing}
                        data-testid={`wizard-btn-gallery-${currentDoc.key}`}
                      >
                        <FileImage className="w-5 h-5" />
                        <span className="text-xs">Subir Archivo</span>
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Missing docs warning when at last doc */}
      {currentIdx === totalDocs - 1 && capturedCount < totalDocs && (
        <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
            <div>
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                Faltan {totalDocs - capturedCount} documento{totalDocs - capturedCount > 1 ? "s" : ""}
              </p>
              <p className="text-[10px] text-amber-600 dark:text-amber-500 mt-0.5">
                {captureList.filter((d) => !previews[d.key]).map((d) => d.label).join(", ")}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Navigation buttons */}
      <div className="flex gap-3">
        {currentIdx > 0 && (
          <Button
            variant="outline"
            className="gap-2"
            onClick={handlePrev}
            data-testid="wizard-prev"
          >
            <ArrowLeft className="w-4 h-4" />
            Anterior
          </Button>
        )}
        <Button
          className="gap-2 ml-auto"
          onClick={handleNext}
          disabled={
            currentIdx === totalDocs - 1
              ? capturedCount < totalDocs || isAnalyzing  // Block advance unless ALL docs captured
              : !isCurrentCaptured || isAnalyzing           // Block next unless current is captured
          }
          data-testid="wizard-next"
        >
          {currentIdx === totalDocs - 1 ? (
            <>
              Continuar al siguiente paso ({capturedCount}/{totalDocs})
              <ArrowRight className="w-4 h-4" />
            </>
          ) : (
            <>
              Siguiente Documento
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// ===== Document Summary (read-only view for steps 3 & 4) =====
function DocumentSummary({
  origination,
  docs,
  stepKeys,
}: {
  origination: Origination;
  docs: DocType[];
  stepKeys: string[];
}) {
  const getDoc = (key: string) => docs.find((d) => d.tipo === key);

  return (
    <div className="grid grid-cols-2 gap-3">
      {stepKeys.map((key) => {
        const doc = getDoc(key);
        const label =
          CAPTURE_DOCUMENTS.find((c) => c.key === key)?.label ||
          (DOCUMENT_TYPES as any)[key]?.label ||
          key;

        return (
          <Card
            key={key}
            className={`transition-colors ${doc ? "border-emerald-200 dark:border-emerald-800" : ""}`}
          >
            <CardContent className="p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium truncate flex-1 mr-1">{label}</span>
                {doc ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                ) : (
                  <Circle className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                )}
              </div>
              {doc?.imageData ? (
                <div className="w-full aspect-[4/3] rounded-lg overflow-hidden border border-border bg-muted">
                  <img
                    src={doc.imageData}
                    alt={label}
                    className="w-full h-full object-contain"
                  />
                </div>
              ) : (
                <div className="w-full aspect-[4/3] rounded-lg bg-muted/30 border border-dashed border-border flex items-center justify-center">
                  <Lock className="w-5 h-5 text-muted-foreground/50" />
                </div>
              )}
              {doc && (
                <Badge
                  variant="secondary"
                  className="text-[10px] w-full justify-center bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                >
                  Capturado
                </Badge>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ===== OTP Verification Component (Twilio Verify) =====
function OtpVerification({
  origination,
  onVerified,
  readOnly = false,
  onUpdate,
  refreshAll,
}: {
  origination: Origination;
  onVerified: () => void;
  readOnly?: boolean;
  onUpdate: (data: Record<string, any>) => Promise<void>;
  refreshAll: () => void;
}) {
  const { toast } = useToast();
  const phone = origination.otpPhone || "";
  const [editablePhone, setEditablePhone] = useState(phone);
  const [otpSent, setOtpSent] = useState(false);
  const [isSimulated, setIsSimulated] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [otpDigits, setOtpDigits] = useState<string[]>(["" , "", "", "", "", ""]);
  const [cooldown, setCooldown] = useState(0);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Cooldown timer
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const sendOtp = useCallback(async () => {
    const phoneToUse = editablePhone.replace(/\D/g, "");
    if (phoneToUse.length < 10) {
      toast({ title: "Teléfono inválido", description: "Ingresa un número de 10 dígitos", variant: "destructive" });
      return;
    }
    setIsSending(true);
    try {
      const result = await apiSendOtp(phoneToUse, origination.id);
      if (result.success) {
        setOtpSent(true);
        setIsSimulated(!!result.simulated);
        setCooldown(60);
        toast({
          title: result.simulated ? "Código enviado (simulación)" : "Código SMS enviado",
          description: result.simulated
            ? "Modo simulación: ingresa cualquier código de 6 dígitos"
            : `SMS enviado a ${result.phone || phoneToUse}`,
        });
        // Focus first OTP input
        setTimeout(() => inputRefs.current[0]?.focus(), 100);
      } else {
        toast({ title: "Error al enviar OTP", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setIsSending(false);
    }
  }, [editablePhone, origination.id, toast]);

  const verifyOtp = useCallback(async () => {
    const code = otpDigits.join("");
    if (code.length !== 6) {
      toast({ title: "Ingresa los 6 dígitos", variant: "destructive" });
      return;
    }
    const phoneToUse = editablePhone.replace(/\D/g, "");
    setIsVerifying(true);
    try {
      const result = await apiVerifyOtp(phoneToUse, code, origination.id);
      if (result.verified) {
        await onUpdate({ otpVerified: 1 });
        toast({ title: "Teléfono verificado correctamente" });
        refreshAll();
        onVerified();
      } else {
        toast({ title: "Código incorrecto", description: result.message || "Intenta de nuevo", variant: "destructive" });
        setOtpDigits(["", "", "", "", "", ""]);
        inputRefs.current[0]?.focus();
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setIsVerifying(false);
    }
  }, [otpDigits, editablePhone, origination.id, onUpdate, toast, onVerified, refreshAll]);

  const handleDigitChange = useCallback((index: number, value: string) => {
    if (!/^\d?$/.test(value)) return;
    const newDigits = [...otpDigits];
    newDigits[index] = value;
    setOtpDigits(newDigits);
    // Auto-advance to next input
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
    // Auto-submit when all 6 digits filled
    if (value && index === 5 && newDigits.every((d) => d)) {
      // Small delay to let state update
      setTimeout(() => {
        const code = newDigits.join("");
        if (code.length === 6) {
          // Trigger verify
        }
      }, 50);
    }
  }, [otpDigits]);

  const handleDigitKeyDown = useCallback((index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !otpDigits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
    if (e.key === "Enter") {
      const code = otpDigits.join("");
      if (code.length === 6) verifyOtp();
    }
  }, [otpDigits, verifyOtp]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length > 0) {
      const newDigits = [...otpDigits];
      for (let i = 0; i < pasted.length; i++) {
        newDigits[i] = pasted[i];
      }
      setOtpDigits(newDigits);
      const focusIdx = Math.min(pasted.length, 5);
      inputRefs.current[focusIdx]?.focus();
    }
  }, [otpDigits]);

  if (origination.otpVerified === 1) {
    return (
      <Card className="border-emerald-200 dark:border-emerald-800">
        <CardContent className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <p className="text-sm font-medium">Teléfono verificado</p>
            <p className="text-xs text-muted-foreground">{phone || "Número confirmado"}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (readOnly) {
    return (
      <Card>
        <CardContent className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
            <Phone className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">Teléfono no verificado</p>
            <p className="text-xs text-muted-foreground">Pendiente de verificación OTP</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Shield className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-medium">Verificación de Teléfono</h3>
            <p className="text-xs text-muted-foreground">
              Enviaremos un código SMS al teléfono del taxista
            </p>
          </div>
        </div>

        {/* Phone input */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Teléfono (10 dígitos)</label>
          <div className="flex gap-2">
            <div className="flex items-center gap-1 px-3 border rounded-md bg-muted/50 text-sm text-muted-foreground">
              +52
            </div>
            <Input
              value={editablePhone}
              onChange={(e) => setEditablePhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
              placeholder="4491234567"
              type="tel"
              maxLength={10}
              className="font-mono"
              disabled={otpSent}
              data-testid="input-otp-phone"
            />
          </div>
        </div>

        {!otpSent ? (
          <Button
            className="w-full gap-2"
            onClick={sendOtp}
            disabled={isSending || editablePhone.replace(/\D/g, "").length < 10}
            data-testid="button-send-otp"
          >
            {isSending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Phone className="w-4 h-4" />
            )}
            {isSending ? "Enviando..." : "Enviar Código SMS"}
          </Button>
        ) : (
          <div className="space-y-4">
            {isSimulated && (
              <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-center">
                <p className="text-[10px] text-amber-700 dark:text-amber-400 font-medium">Modo simulación (cuenta Twilio trial)</p>
                <p className="text-[10px] text-amber-600 dark:text-amber-500 mt-0.5">Ingresa cualquier código de 6 dígitos</p>
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-2 block text-center">Ingresa el código de 6 dígitos</label>
              <div className="flex justify-center gap-2" onPaste={handlePaste}>
                {otpDigits.map((digit, i) => (
                  <input
                    key={i}
                    ref={(el) => { inputRefs.current[i] = el; }}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleDigitChange(i, e.target.value)}
                    onKeyDown={(e) => handleDigitKeyDown(i, e)}
                    className="w-11 h-12 text-center text-lg font-mono font-bold border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary transition-all"
                    data-testid={`input-otp-digit-${i}`}
                  />
                ))}
              </div>
            </div>

            <Button
              className="w-full gap-2"
              onClick={verifyOtp}
              disabled={isVerifying || otpDigits.join("").length < 6}
              data-testid="button-verify-otp"
            >
              {isVerifying ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              {isVerifying ? "Verificando..." : "Verificar Código"}
            </Button>

            <div className="flex items-center justify-between text-xs">
              <button
                onClick={() => { setOtpSent(false); setOtpDigits(["", "", "", "", "", ""]); }}
                className="text-muted-foreground hover:text-foreground transition-colors"
                data-testid="button-change-phone"
              >
                Cambiar número
              </button>
              <button
                onClick={sendOtp}
                disabled={cooldown > 0 || isSending}
                className={`transition-colors ${cooldown > 0 ? "text-muted-foreground/50" : "text-primary hover:text-primary/80"}`}
                data-testid="button-resend-otp"
              >
                {cooldown > 0 ? `Reenviar en ${cooldown}s` : "Reenviar código"}
              </button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ===== DocumentCapture (used in Step 5) =====
function DocumentCapture({
  originationId,
  docType,
  label,
  existingDoc,
  onCaptured,
  readOnly = false,
}: {
  originationId: number;
  docType: string;
  label: string;
  existingDoc?: DocType;
  onCaptured: () => void;
  readOnly?: boolean;
}) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [preview, setPreview] = useState<string | null>(existingDoc?.imageData || null);
  const [ocrResult, setOcrResult] = useState<Record<string, any> | null>(
    existingDoc?.ocrResult ? JSON.parse(existingDoc.ocrResult) : null
  );
  const [editedData, setEditedData] = useState<Record<string, any> | null>(
    existingDoc?.editedData ? JSON.parse(existingDoc.editedData) : null
  );
  const [showOcr, setShowOcr] = useState(readOnly && !!ocrResult);

  const handleCapture = useCallback(async (file: File) => {
    if (readOnly) return;
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "Archivo muy grande", description: "Máximo 10MB", variant: "destructive" });
      return;
    }

    setIsCapturing(true);
    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target?.result as string;
      setPreview(dataUrl);
      setIsCapturing(false);
      setIsAnalyzing(true);

      try {
        // Vehicle photos & selfie_ine don't need OCR, just save
        const isPhotoOnly = docType.startsWith("vehiculo_") || docType === "selfie_ine";
        if (isPhotoOnly) {
          await apiSaveDocument({
            originationId,
            tipo: docType,
            imageData: dataUrl,
            ocrResult: JSON.stringify({ status: "capturado" }),
            ocrConfidence: "alta",
            editedData: JSON.stringify({ status: "capturado" }),
            status: "ocr_done",
          });
          setOcrResult({ status: "capturado" });
          setEditedData({ status: "capturado" });
          toast({ title: "Foto capturada", description: label });
        } else {
          // Use real OCR for document types
          const result = await apiRunOcr({ originationId, docType, imageData: dataUrl });
          setOcrResult(result.extractedData);
          setEditedData(result.extractedData);
          setShowOcr(true);
          toast({
            title: result.confidence === "alta" ? "Documento procesado" : "Documento procesado (verificar)",
            description: `${label} — confianza ${result.confidence}`,
            variant: result.confidence === "baja" ? "destructive" : undefined,
          });
        }
        onCaptured();
      } catch (err: any) {
        toast({ title: "Error", description: err.message || "No se pudo procesar", variant: "destructive" });
      } finally {
        setIsAnalyzing(false);
      }
    };
    reader.readAsDataURL(file);
  }, [originationId, docType, label, toast, onCaptured, readOnly]);

  const handleSaveEdits = useCallback(async () => {
    if (!editedData || readOnly) return;
    try {
      await apiSaveDocument({
        originationId,
        tipo: docType,
        imageData: preview || "",
        editedData: JSON.stringify(editedData),
        status: "ocr_done",
      });
      toast({ title: "Datos guardados" });
      onCaptured();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  }, [originationId, docType, editedData, preview, toast, onCaptured, readOnly]);

  const isDone = existingDoc?.status === "ocr_done" || existingDoc?.status === "verified";

  return (
    <Card className={`transition-colors ${isDone ? "border-emerald-200 dark:border-emerald-800" : ""}`}>
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {isDone ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            ) : readOnly ? (
              <Lock className="w-4 h-4 text-muted-foreground" />
            ) : (
              <Camera className="w-4 h-4 text-muted-foreground" />
            )}
            <span className="text-xs font-medium">{label}</span>
          </div>
          {isDone && (
            <Badge variant="secondary" className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
              Capturado
            </Badge>
          )}
        </div>

        {!readOnly && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleCapture(file);
              }}
              data-testid={`input-doc-gallery-${docType}`}
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleCapture(file);
              }}
              data-testid={`input-doc-camera-${docType}`}
            />
          </>
        )}

        {preview ? (
          <div className="space-y-2">
            <div className="relative aspect-[4/3] rounded-lg overflow-hidden border border-border bg-muted">
              <img src={preview} alt={label} className="w-full h-full object-contain" />
              {isAnalyzing && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <div className="text-center text-white">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-1" />
                    <span className="text-xs">Analizando...</span>
                  </div>
                </div>
              )}
            </div>

            {ocrResult && (
              <div className="space-y-2">
                <button
                  onClick={() => setShowOcr(!showOcr)}
                  className="text-xs text-primary font-medium flex items-center gap-1"
                  data-testid={`button-toggle-ocr-${docType}`}
                >
                  <Eye className="w-3 h-3" />
                  {showOcr ? "Ocultar datos" : "Ver datos extraídos"}
                </button>
                {showOcr && editedData && (
                  <div className="space-y-1.5 bg-muted/50 rounded-lg p-2">
                    {Object.entries(editedData).map(([key, value]) => (
                      <div key={key} className="flex items-center gap-2">
                        <label className="text-[10px] font-medium text-muted-foreground w-24 flex-shrink-0 capitalize">
                          {key.replace(/_/g, " ")}
                        </label>
                        {readOnly ? (
                          <span className="text-xs font-medium">{String(value || "—")}</span>
                        ) : (
                          <Input
                            value={String(value || "")}
                            onChange={(e) => setEditedData({ ...editedData, [key]: e.target.value })}
                            className="h-7 text-xs"
                            data-testid={`input-ocr-${docType}-${key}`}
                          />
                        )}
                      </div>
                    ))}
                    {!readOnly && (
                      <Button size="sm" variant="outline" className="w-full mt-1 text-xs h-7" onClick={handleSaveEdits}>
                        Guardar cambios
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}

            {!readOnly && (
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs gap-1.5"
                  onClick={() => cameraInputRef.current?.click()}
                >
                  <Camera className="w-3 h-3" />
                  Tomar foto
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs gap-1.5"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileImage className="w-3 h-3" />
                  Subir archivo
                </Button>
              </div>
            )}
          </div>
        ) : readOnly ? (
          <div className="w-full border rounded-lg p-4 flex flex-col items-center gap-1.5 bg-muted/20">
            <Lock className="w-5 h-5 text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground">No capturado</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => cameraInputRef.current?.click()}
              disabled={isCapturing}
              className="border-2 border-dashed border-border rounded-lg p-3 flex flex-col items-center gap-1 hover:border-primary/50 hover:bg-muted/30 transition-colors"
              data-testid={`button-camera-${docType}`}
            >
              {isCapturing ? (
                <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
              ) : (
                <Camera className="w-5 h-5 text-muted-foreground" />
              )}
              <span className="text-[10px] text-muted-foreground">
                {isCapturing ? "Cargando..." : "Tomar foto"}
              </span>
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isCapturing}
              className="border-2 border-dashed border-border rounded-lg p-3 flex flex-col items-center gap-1 hover:border-primary/50 hover:bg-muted/30 transition-colors"
              data-testid={`button-gallery-${docType}`}
            >
              <FileImage className="w-5 h-5 text-muted-foreground" />
              <span className="text-[10px] text-muted-foreground">Subir archivo</span>
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ===== Step 4: Editable OCR Review =====
function EditableOcrReview({
  origination,
  docs,
  docKeys,
  readOnly,
  refreshAll,
}: {
  origination: Origination;
  docs: DocType[];
  docKeys: string[];
  readOnly: boolean;
  refreshAll: () => void;
}) {
  const { toast } = useToast();
  const [editedFields, setEditedFields] = useState<Record<string, Record<string, string>>>(() => {
    const initial: Record<string, Record<string, string>> = {};
    docs.forEach((d) => {
      if (d.editedData || d.ocrResult) {
        try {
          initial[d.tipo] = JSON.parse(d.editedData || d.ocrResult || "{}");
        } catch { initial[d.tipo] = {}; }
      }
    });
    return initial;
  });
  const [savingDoc, setSavingDoc] = useState<string | null>(null);
  const [expandedDocs, setExpandedDocs] = useState<Record<string, boolean>>({});

  const toggleExpand = (key: string) => {
    setExpandedDocs((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleFieldChange = (docKey: string, field: string, value: string) => {
    setEditedFields((prev) => ({
      ...prev,
      [docKey]: { ...prev[docKey], [field]: value },
    }));
  };

  const handleSaveDoc = async (docKey: string) => {
    setSavingDoc(docKey);
    try {
      const doc = docs.find((d) => d.tipo === docKey);
      await apiSaveDocument({
        originationId: origination.id,
        tipo: docKey,
        imageData: doc?.imageData || "",
        editedData: JSON.stringify(editedFields[docKey] || {}),
        status: "verified",
      });
      toast({ title: "Datos guardados", description: CAPTURE_DOCUMENTS.find((c) => c.key === docKey)?.label || docKey });
      refreshAll();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSavingDoc(null);
    }
  };

  const getDoc = (key: string) => docs.find((d) => d.tipo === key);
  const getConfBadge = (doc: DocType | undefined) => {
    if (!doc?.ocrConfidence) return null;
    const conf = doc.ocrConfidence;
    if (conf === "alta") return { color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 border-emerald-300", icon: CheckCircle2, label: "Confianza Alta" };
    if (conf === "media") return { color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 border-amber-300", icon: AlertTriangle, label: "Confianza Media" };
    return { color: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 border-red-300", icon: AlertTriangle, label: "Confianza Baja" };
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Edit3 className="w-4 h-4 text-primary" />
          Resumen del Expediente
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          {readOnly
            ? "Datos extraídos por OCR de cada documento"
            : "Revisa y corrige los datos extraídos. Los campos editados se guardan al presionar 'Guardar'."}
        </p>
      </div>

      {docKeys.map((docKey) => {
        const doc = getDoc(docKey);
        const label = CAPTURE_DOCUMENTS.find((c) => c.key === docKey)?.label || docKey;
        const fields = editedFields[docKey] || {};
        const confBadge = getConfBadge(doc);
        const isExpanded = expandedDocs[docKey] !== false; // default expanded
        const hasFields = Object.keys(fields).length > 0;
        const isSelfie = docKey === "selfie_biometrico";

        return (
          <Card key={docKey} className={`overflow-hidden transition-colors ${
            doc?.status === "verified" ? "border-emerald-200 dark:border-emerald-800" :
            doc ? "border-border" : "border-muted"
          }`}>
            {/* Doc header */}
            <button
              onClick={() => toggleExpand(docKey)}
              className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-muted/20 transition-colors"
              data-testid={`ocr-review-toggle-${docKey}`}
            >
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                doc ? "bg-primary/10" : "bg-muted"
              }`}>
                {doc?.imageData ? (
                  <img src={doc.imageData} alt="" className="w-full h-full object-cover rounded-lg" />
                ) : (
                  <FileText className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold truncate">{label}</span>
                  {confBadge && (
                    <Badge className={`text-[9px] ${confBadge.color}`}>
                      <confBadge.icon className="w-2.5 h-2.5 mr-0.5" />
                      {confBadge.label}
                    </Badge>
                  )}
                  {doc?.status === "verified" && (
                    <Badge className="text-[9px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 border-emerald-300">
                      Verificado
                    </Badge>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {!doc ? "No capturado" : hasFields ? `${Object.keys(fields).length} campos` : "Sin datos OCR"}
                </p>
              </div>
              <ArrowRight className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`} />
            </button>

            {/* Expanded fields */}
            {isExpanded && doc && !isSelfie && hasFields && (
              <CardContent className="px-4 pb-4 pt-0 border-t">
                <div className="space-y-2 mt-3">
                  {Object.entries(fields).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-2">
                      <label className="text-[10px] font-medium text-muted-foreground w-28 flex-shrink-0 capitalize">
                        {key.replace(/_/g, " ")}
                      </label>
                      {readOnly ? (
                        <span className="text-xs font-medium">{String(value || "—")}</span>
                      ) : (
                        <Input
                          value={String(value || "")}
                          onChange={(e) => handleFieldChange(docKey, key, e.target.value)}
                          className="h-7 text-xs"
                          data-testid={`ocr-field-${docKey}-${key}`}
                        />
                      )}
                    </div>
                  ))}
                  {!readOnly && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full mt-2 text-xs h-8 gap-1.5"
                      onClick={() => handleSaveDoc(docKey)}
                      disabled={savingDoc === docKey}
                      data-testid={`ocr-save-${docKey}`}
                    >
                      {savingDoc === docKey ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Save className="w-3 h-3" />
                      )}
                      Guardar cambios
                    </Button>
                  )}
                </div>
              </CardContent>
            )}

            {/* Selfie thumbnail */}
            {isExpanded && doc && isSelfie && doc.imageData && (
              <CardContent className="px-4 pb-4 pt-0 border-t">
                <div className="mt-3 w-20 h-20 rounded-lg overflow-hidden border">
                  <img src={doc.imageData} alt="Selfie" className="w-full h-full object-cover" />
                </div>
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ===== Step Content Renderer =====
function StepContent({
  step,
  origination,
  docs,
  readOnly,
  refreshAll,
  onUpdate,
  onAllDocsCaptured,
}: {
  step: number;
  origination: Origination;
  docs: DocType[];
  readOnly: boolean;
  refreshAll: () => void;
  onUpdate: (data: Record<string, any>) => Promise<void>;
  onAllDocsCaptured: () => void;
}) {
  const getDoc = (tipo: string) => docs?.find((d) => d.tipo === tipo);

  if (step === 1) {
    return (
      <Card className="overflow-hidden">
        <div className="px-5 py-3 bg-muted/30 border-b">
          <h3 className="text-sm font-semibold">Folio Creado</h3>
        </div>
        <CardContent className="p-5">
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="space-y-0.5">
              <span className="text-muted-foreground">Folio</span>
              <p className="font-bold font-mono">{origination.folio}</p>
            </div>
            <div className="space-y-0.5">
              <span className="text-muted-foreground">Tipo</span>
              <p className="font-bold">{origination.tipo === "validacion" ? "Validación" : "Compraventa"}</p>
            </div>
            <div className="space-y-0.5">
              <span className="text-muted-foreground">Perfil</span>
              <p className="font-bold">{origination.perfilTipo}</p>
            </div>
            <div className="space-y-0.5">
              <span className="text-muted-foreground">Creado</span>
              <p className="font-bold">{formatDate(origination.createdAt)}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (step === 2) {
    if (readOnly) {
      // Show summary of all captured docs for step 2
      const step2Keys = CAPTURE_DOCUMENTS
        .filter((doc) => !doc.profileFilter || doc.profileFilter === origination.perfilTipo)
        .map((doc) => doc.key);
      return (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Documentos Capturados</h3>
          <p className="text-xs text-muted-foreground">Resumen de todos los documentos del expediente</p>
          <DocumentSummary origination={origination} docs={docs} stepKeys={step2Keys} />
        </div>
      );
    }
    return (
      <DocumentWizard
        origination={origination}
        docs={docs}
        onAllCaptured={onAllDocsCaptured}
        refreshAll={refreshAll}
      />
    );
  }

  // Steps 3 & 4: Summary of documents captured in Step 2 wizard
  if (step === 3) {
    return (
      <div className="space-y-4">
        <OtpVerification
          origination={origination}
          onVerified={() => {
            onUpdate({ currentStep: 4 });
            refreshAll();
          }}
          readOnly={readOnly}
          onUpdate={onUpdate}
          refreshAll={refreshAll}
        />
      </div>
    );
  }

  if (step === 4) {
    // Step 4: Editable OCR data review organized by document
    const allDocKeys = [
      "ine_frente", "ine_reverso", "csf", "comprobante_domicilio",
      "concesion", "estado_cuenta",
      ...(origination.perfilTipo === "A" ? ["historial_gnv"] : []),
      "factura_vehiculo",
      ...(origination.perfilTipo === "A" ? ["carta_membresia"] : []),
      "selfie_biometrico",
    ];
    return (
      <EditableOcrReview
        origination={origination}
        docs={docs}
        docKeys={allDocKeys}
        readOnly={readOnly}
        refreshAll={refreshAll}
      />
    );
  }

  if (step === 5) {
    const vehiclePhotos: DocumentType[] = ["vehiculo_frente", "vehiculo_trasera", "vehiculo_lateral_izq", "vehiculo_lateral_der"];
    const selfieDoc = getDoc("selfie_ine");
    const vehiclePhotosCaptured = vehiclePhotos.filter((vp) => !!getDoc(vp)).length;
    const allStep5Done = !!selfieDoc && vehiclePhotosCaptured === 4;

    return (
      <div className="space-y-5">
        {/* Selfie con INE */}
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2 mb-1">
            <ScanFace className="w-4 h-4 text-violet-600" />
            Selfie con INE
          </h3>
          <p className="text-xs text-muted-foreground mb-3">
            El taxista sostiene su INE junto a su rostro
          </p>
          <DocumentCapture
            originationId={origination.id}
            docType="selfie_ine"
            label="Selfie con INE"
            existingDoc={selfieDoc}
            onCaptured={refreshAll}
            readOnly={readOnly}
          />
        </div>

        {/* Fotos del Vehículo */}
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2 mb-1">
            <Car className="w-4 h-4 text-primary" />
            Fotos del Vehículo ({vehiclePhotosCaptured}/4)
          </h3>
          <p className="text-xs text-muted-foreground mb-3">
            Captura las 4 vistas del vehículo: frente, trasera, lateral izquierda y lateral derecha
          </p>
          <div className="grid grid-cols-2 gap-3">
            {vehiclePhotos.map((docType) => (
              <DocumentCapture
                key={docType}
                originationId={origination.id}
                docType={docType}
                label={DOCUMENT_TYPES[docType].label}
                existingDoc={getDoc(docType)}
                onCaptured={refreshAll}
                readOnly={readOnly}
              />
            ))}
          </div>
        </div>

        {/* Progress summary */}
        {!readOnly && !allStep5Done && (
          <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Faltan: {!selfieDoc ? "Selfie con INE, " : ""}
                {vehiclePhotos.filter((vp) => !getDoc(vp)).map((vp) => DOCUMENT_TYPES[vp].label).join(", ")}
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (step === 6) {
    return (
      <div className="space-y-4">
        <h3 className="text-sm font-medium">Contrato</h3>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <FileText className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs font-medium">
                {origination.tipo === "validacion" ? "Convenio de Validación" : "Contrato de Compraventa"}
              </span>
            </div>
            {origination.contractUrl ? (
              <div className="bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-lg p-3 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Contrato generado</span>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Contrato pendiente de generación</p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (step === 7) {
    return (
      <div className="space-y-4">
        <h3 className="text-sm font-medium">Firma Electrónica</h3>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs font-medium">Firma Electrónica — Mifiel</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {origination.mifielStatus === "signed"
                ? "Documento firmado electrónicamente"
                : "Pendiente de firma electrónica"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return null;
}

// ===== Main Flow Page =====
export default function OriginacionFlowPage() {
  const { toast } = useToast();
  const params = useParams<{ id: string }>();
  const originationId = parseInt(params.id || "0");

  // Async state for origination and docs
  const [origination, setOrigination] = useState<Origination | null>(null);
  const [docs, setDocs] = useState<DocType[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Track which step the user is viewing (may differ from currentStep for read-only)
  const [viewingStep, setViewingStep] = useState<number | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  // Load data from API
  const refreshAll = useCallback(async () => {
    if (!originationId) return;
    try {
      const [orig, docsData] = await Promise.all([
        apiGetOrigination(originationId),
        apiGetDocuments(originationId),
      ]);
      if (orig) setOrigination(orig);
      if (docsData) setDocs(docsData);
    } catch (err) {
      console.error("Failed to refresh data:", err);
    }
  }, [originationId]);

  // Initial load
  useEffect(() => {
    if (!originationId) return;
    setIsLoading(true);
    Promise.all([
      apiGetOrigination(originationId),
      apiGetDocuments(originationId),
    ])
      .then(([orig, docsData]) => {
        if (orig) setOrigination(orig);
        if (docsData) setDocs(docsData);
      })
      .catch((err) => console.error("Failed to load origination:", err))
      .finally(() => setIsLoading(false));
  }, [originationId]);

  // Subscribe to in-memory store changes (for storage fallback path)
  useEffect(() => {
    const unsub = subscribe(() => {
      refreshAll();
    });
    return unsub;
  }, [refreshAll]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-3">
          <Loader2 className="w-10 h-10 text-primary mx-auto animate-spin" />
          <p className="text-sm text-muted-foreground">Cargando folio...</p>
        </div>
      </div>
    );
  }

  if (!origination) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-2">
          <FileText className="w-10 h-10 text-muted-foreground mx-auto opacity-40" />
          <p className="text-sm text-muted-foreground">Folio no encontrado</p>
          <Link href="/originacion">
            <Button variant="outline" size="sm" className="mt-2 gap-1.5">
              <ArrowLeft className="w-3.5 h-3.5" />
              Volver a Originación
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  const currentStep = origination.currentStep;
  const activeStep = viewingStep ?? currentStep;
  const isViewingPast = viewingStep !== null && viewingStep < currentStep;
  const progress = ((currentStep - 1) / 6) * 100;

  const advanceStep = async (step: number) => {
    const estado = step <= 4 ? "CAPTURANDO" : step === 5 ? "VALIDADO" : step === 6 ? "GENERADO" : "FIRMADO";
    const updated = await apiUpdateOrigination(originationId, { currentStep: step, estado });
    if (updated) setOrigination(updated);
    setViewingStep(null);
  };

  const updateOriginationData = async (data: Record<string, any>) => {
    const updated = await apiUpdateOrigination(originationId, data);
    if (updated) setOrigination(updated);
  };

  const generateContract = async () => {
    setIsGenerating(true);
    try {
      const taxista = origination.taxistaId ? getTaxista(origination.taxistaId) : null;
      const vehicle = origination.vehicleInventoryId ? getVehicle(origination.vehicleInventoryId) : null;

      let blob: Blob;
      let contractType: string;
      if (origination.tipo === "validacion") {
        blob = generateConvenioValidacion(origination, taxista || null, vehicle || null);
        contractType = "convenio_validacion";
      } else {
        blob = generateContratoCompraventa(origination, taxista || null, vehicle || null);
        contractType = "contrato_compraventa";
      }

      const url = URL.createObjectURL(blob);
      const updated = await apiUpdateOrigination(originationId, {
        contractType,
        contractUrl: url,
        contractGeneratedAt: new Date().toISOString(),
      });
      if (updated) setOrigination(updated);

      toast({ title: "Contrato generado" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message || "No se pudo generar el contrato", variant: "destructive" });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownloadContract = () => {
    if (origination.contractUrl) {
      const a = document.createElement("a");
      a.href = origination.contractUrl;
      a.download = `${origination.folio}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  const handleStepClick = (step: number) => {
    if (step <= currentStep) {
      setViewingStep(step === currentStep ? null : step);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/originacion" className="p-2 rounded-lg hover:bg-muted transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono font-bold">{origination.folio}</span>
            <Badge variant="outline" className="text-[10px]">
              {origination.tipo === "validacion" ? "Validación" : "Compraventa"}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              Perfil {origination.perfilTipo}
            </Badge>
          </div>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Creado: {formatDate(origination.createdAt)}
          </p>
        </div>
      </div>

      {/* Progress + Navigable Stepper */}
      <div className="space-y-3">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium">
            {isViewingPast ? (
              <span className="text-amber-600 dark:text-amber-400">
                Viendo paso {activeStep}: {ORIGINATION_STEPS.find((s) => s.step === activeStep)?.name} (solo lectura)
              </span>
            ) : (
              <>Paso {currentStep} de 7: {ORIGINATION_STEPS.find((s) => s.step === currentStep)?.name}</>
            )}
          </span>
          <span className="text-muted-foreground tabular-nums font-semibold">{Math.round(progress)}%</span>
        </div>
        <Progress value={progress} className="h-2" />
        <div className="flex justify-between">
          {ORIGINATION_STEPS.map((s) => (
            <button
              key={s.step}
              onClick={() => handleStepClick(s.step)}
              className={`w-8 h-8 rounded-full text-[10px] font-medium flex items-center justify-center transition-all duration-200 ${
                s.step < currentStep
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 cursor-pointer hover:ring-2 hover:ring-emerald-400"
                  : s.step === currentStep
                  ? "bg-primary text-primary-foreground shadow-md"
                  : "bg-muted text-muted-foreground cursor-not-allowed"
              } ${activeStep === s.step && isViewingPast ? "ring-2 ring-amber-400" : ""}`}
              data-testid={`step-${s.step}`}
              title={`${s.name}${s.step < currentStep ? " (ver)" : s.step === currentStep ? " (actual)" : ""}`}
              disabled={s.step > currentStep}
            >
              {s.step < currentStep ? "✓" : s.step}
            </button>
          ))}
        </div>
        {isViewingPast && (
          <button
            onClick={() => setViewingStep(null)}
            className="text-xs text-primary font-medium hover:underline flex items-center gap-1"
            data-testid="button-back-to-current"
          >
            <ArrowLeft className="w-3 h-3" />
            Volver al paso actual ({currentStep})
          </button>
        )}
      </div>

      {/* Step Content */}
      <StepContent
        step={activeStep}
        origination={origination}
        docs={docs}
        readOnly={isViewingPast}
        refreshAll={refreshAll}
        onUpdate={updateOriginationData}
        onAllDocsCaptured={() => advanceStep(3)}
      />

      {/* Navigation buttons (only when viewing current step) */}
      {!isViewingPast && (
        <>
          {/* Step 1: Start */}
          {currentStep === 1 && (
            <Button
              className="w-full gap-2 h-12"
              onClick={() => advanceStep(2)}
              data-testid="button-start-capture"
            >
              <Camera className="w-4 h-4" />
              Iniciar Captura de Documentos
              <ArrowRight className="w-4 h-4" />
            </Button>
          )}

          {/* Steps 3 & 4: Next/Prev — Step 2 advances itself via onAllDocsCaptured */}
          {(currentStep === 3 || currentStep === 4) && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => advanceStep(currentStep - 1)}>
                <ArrowLeft className="w-3.5 h-3.5" />
                Anterior
              </Button>
              <Button
                size="sm"
                className="gap-1.5 ml-auto"
                onClick={() => advanceStep(currentStep + 1)}
                data-testid="button-next-step"
              >
                Siguiente
                <ArrowRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}

          {/* Step 5: Verification nav */}
          {currentStep === 5 && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => advanceStep(4)}>
                <ArrowLeft className="w-3.5 h-3.5" />
                Anterior
              </Button>
              <Button
                size="sm"
                className="gap-1.5 ml-auto"
                onClick={() => advanceStep(6)}
                data-testid="button-next-step"
              >
                Siguiente
                <ArrowRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}

          {/* Step 6: Contract Generation */}
          {currentStep === 6 && (
            <div className="space-y-3">
              {!origination.contractUrl && (
                <Button
                  className="w-full gap-2"
                  onClick={generateContract}
                  disabled={isGenerating}
                  data-testid="button-generate-contract"
                >
                  {isGenerating ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <FileText className="w-4 h-4" />
                  )}
                  Generar Contrato PDF
                </Button>
              )}
              {origination.contractUrl && (
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={handleDownloadContract}
                  data-testid="button-download-contract"
                >
                  <Download className="w-3.5 h-3.5" />
                  Descargar PDF
                </Button>
              )}
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => advanceStep(5)}>
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Anterior
                </Button>
                <Button
                  size="sm"
                  className="gap-1.5 ml-auto"
                  onClick={() => advanceStep(7)}
                  disabled={!origination.contractUrl}
                  data-testid="button-next-step"
                >
                  Siguiente
                  <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 7: Mifiel */}
          {currentStep === 7 && (
            <div className="space-y-3">
              <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
                <p className="text-xs text-blue-700 dark:text-blue-400">
                  La integración con Mifiel se implementará en una futura iteración.
                  Por ahora, descarga el PDF para firma manual o envío.
                </p>
              </div>
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={handleDownloadContract}
                data-testid="button-download-mifiel"
              >
                <Download className="w-4 h-4" />
                Descargar PDF para Firma
              </Button>
              <a
                href="https://app.mifiel.com"
                target="_blank"
                rel="noopener noreferrer"
                className="block"
              >
                <Button variant="outline" className="w-full gap-2 text-blue-600">
                  <Shield className="w-4 h-4" />
                  Ir a Mifiel (firma manual)
                </Button>
              </a>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => advanceStep(6)}>
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Anterior
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
