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
  profileFilter?: "A"; // if set, only show for this profile
}

const CAPTURE_DOCUMENTS: CaptureDocDef[] = [
  {
    key: "ine_frente",
    label: "INE Frente",
    instructions: "Coloca tu INE sobre una superficie plana con buena iluminación. Asegúrate de que los 4 bordes sean visibles.",
  },
  {
    key: "ine_reverso",
    label: "INE Reverso",
    instructions: "Voltea la INE y captura el reverso. Verifica que el código de barras sea legible.",
  },
  {
    key: "csf",
    label: "Constancia de Situación Fiscal",
    instructions: "Captura la Constancia de Situación Fiscal (CSF) del SAT. El RFC y régimen fiscal deben ser legibles.",
  },
  {
    key: "comprobante_domicilio",
    label: "Comprobante de Domicilio",
    instructions: "Recibo de luz, agua o teléfono de los últimos 3 meses. La dirección completa debe ser visible.",
  },
  {
    key: "concesion",
    label: "Concesión de Taxi",
    instructions: "Fotografía la concesión de taxi vigente. El número de concesión y titular deben ser claros.",
  },
  {
    key: "estado_cuenta",
    label: "Estado de Cuenta Bancario",
    instructions: "Estado de cuenta bancario reciente. La CLABE interbancaria y nombre del titular deben ser visibles.",
  },
  {
    key: "historial_gnv",
    label: "Historial de Consumo GNV",
    instructions: "Comprobante de consumo de gas natural vehicular. Debe mostrar el promedio mensual en LEQ.",
    profileFilter: "A",
  },
  {
    key: "factura_vehiculo",
    label: "Factura del Vehículo",
    instructions: "Factura original del vehículo. Marca, modelo, año, número de serie y NIV deben ser legibles.",
  },
  {
    key: "carta_membresia",
    label: "Carta de Membresía",
    instructions: "Carta de membresía de la central de taxistas. Número de membresía y vigencia visibles.",
    profileFilter: "A",
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
};

// ===== Step 2: One-by-one Document Wizard =====
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

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  const currentDoc = captureList[currentIdx];
  const currentPreview = previews[currentDoc?.key] || null;
  const isCurrentCaptured = !!currentPreview;

  // Check if a doc key was already captured (from docs list)
  const getDocStatus = (key: string): "pending" | "captured" | "verified" => {
    if (previews[key]) {
      const existingDoc = docs.find((d) => d.tipo === key);
      if (existingDoc?.status === "verified") return "verified";
      return "captured";
    }
    return "pending";
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

      // Simulated OCR delay
      setTimeout(async () => {
        try {
          const simulated = OCR_TEMPLATES[currentDoc.key] || { status: "capturado" };

          // Save document via API
          await apiSaveDocument({
            originationId: origination.id,
            tipo: currentDoc.key,
            imageData: dataUrl,
            ocrResult: JSON.stringify(simulated),
            ocrConfidence: "media",
            editedData: JSON.stringify(simulated),
            status: "ocr_done",
          });

          toast({ title: "Documento capturado", description: `${currentDoc.label} procesado` });
          refreshAll();
        } catch (err: any) {
          toast({ title: "Error", description: err.message || "No se pudo guardar", variant: "destructive" });
        } finally {
          setIsAnalyzing(false);
        }
      }, 600);
    };
    reader.readAsDataURL(file);
  }, [currentDoc, origination.id, toast, refreshAll]);

  const handleNext = () => {
    if (currentIdx < totalDocs - 1) {
      setCurrentIdx((i) => i + 1);
    } else {
      // All documents captured — advance to step 3
      onAllCaptured();
    }
  };

  const handlePrev = () => {
    if (currentIdx > 0) setCurrentIdx((i) => i - 1);
  };

  if (!currentDoc) return null;

  return (
    <div className="space-y-4">
      {/* Status indicator circles */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {captureList.map((doc, idx) => {
          const status = getDocStatus(doc.key);
          return (
            <button
              key={doc.key}
              onClick={() => setCurrentIdx(idx)}
              title={doc.label}
              className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold transition-all border-2 ${
                idx === currentIdx
                  ? "border-primary scale-110"
                  : "border-transparent"
              } ${
                status === "verified"
                  ? "bg-emerald-500 text-white"
                  : status === "captured"
                  ? "bg-amber-400 text-white"
                  : "bg-muted text-muted-foreground"
              }`}
              data-testid={`wizard-dot-${doc.key}`}
            >
              {status === "verified" ? "✓" : status === "captured" ? "✓" : idx + 1}
            </button>
          );
        })}
      </div>

      {/* Document card */}
      <Card className="border-2">
        <CardContent className="p-5 space-y-4">
          {/* Header */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground font-medium">
                Documento {currentIdx + 1} de {totalDocs}
              </span>
              {isCurrentCaptured && (
                <Badge className="text-[10px] bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 border-amber-300 dark:border-amber-700">
                  Capturado
                </Badge>
              )}
            </div>
            <h2 className="text-xl font-bold leading-tight">{currentDoc.label}</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {currentDoc.instructions}
            </p>
          </div>

          {/* Hidden inputs */}
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
              <div className="relative w-full aspect-[4/3] rounded-xl overflow-hidden border border-border bg-muted">
                <img
                  src={currentPreview}
                  alt={currentDoc.label}
                  className="w-full h-full object-contain"
                />
                {isAnalyzing && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded-xl">
                    <div className="text-center text-white space-y-2">
                      <Loader2 className="w-8 h-8 animate-spin mx-auto" />
                      <p className="text-sm font-medium">Analizando documento...</p>
                    </div>
                  </div>
                )}
              </div>
              {/* Retake button */}
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={() => cameraInputRef.current?.click()}
                disabled={isAnalyzing}
                data-testid={`wizard-retake-${currentDoc.key}`}
              >
                <Camera className="w-4 h-4" />
                Retomar foto
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Capture placeholder */}
              <div className="w-full aspect-[4/3] rounded-xl border-2 border-dashed border-border bg-muted/30 flex flex-col items-center justify-center gap-3">
                {isCapturing ? (
                  <>
                    <Loader2 className="w-10 h-10 text-muted-foreground animate-spin" />
                    <p className="text-sm text-muted-foreground">Cargando...</p>
                  </>
                ) : (
                  <>
                    <ImageIcon className="w-12 h-12 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground text-center px-4">
                      Usa los botones de abajo para capturar o subir este documento
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
                  <span className="text-xs">Subir desde Galería</span>
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

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
          disabled={!isCurrentCaptured || isAnalyzing}
          data-testid="wizard-next"
        >
          {currentIdx === totalDocs - 1 ? (
            <>
              Continuar
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
            className={doc ? "border-emerald-200 dark:border-emerald-800" : ""}
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

// ===== OTP Verification Component =====
function OtpVerification({
  origination,
  onVerified,
  readOnly = false,
  onUpdate,
}: {
  origination: Origination;
  onVerified: () => void;
  readOnly?: boolean;
  onUpdate: (data: Record<string, any>) => Promise<void>;
}) {
  const { toast } = useToast();
  const [otpSent, setOtpSent] = useState(!!origination.otpCode);
  const [displayCode, setDisplayCode] = useState(origination.otpCode || "");
  const [inputCode, setInputCode] = useState("");
  const [isSending, setIsSending] = useState(false);

  const sendOtp = useCallback(async () => {
    setIsSending(true);
    setTimeout(async () => {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await onUpdate({ otpCode: code });
      setDisplayCode(code);
      setOtpSent(true);
      toast({ title: "OTP enviado (simulado)", description: `Código: ${code}` });
      setIsSending(false);
    }, 300);
  }, [onUpdate, toast]);

  const verifyOtp = useCallback(async () => {
    if (inputCode === displayCode) {
      await onUpdate({ otpVerified: 1 });
      toast({ title: "Teléfono verificado" });
      onVerified();
    } else {
      toast({ title: "Código incorrecto", variant: "destructive" });
    }
  }, [inputCode, displayCode, onUpdate, toast, onVerified]);

  if (origination.otpVerified === 1) {
    return (
      <Card className="border-emerald-200 dark:border-emerald-800">
        <CardContent className="p-3 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          <span className="text-xs font-medium">Teléfono verificado</span>
        </CardContent>
      </Card>
    );
  }

  if (readOnly) {
    return (
      <Card>
        <CardContent className="p-3 flex items-center gap-2">
          <Phone className="w-4 h-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Teléfono no verificado</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Phone className="w-4 h-4 text-muted-foreground" />
          <span className="text-xs font-medium">Verificación de Teléfono (OTP simulado)</span>
        </div>

        {!otpSent ? (
          <Button size="sm" className="w-full gap-2" onClick={sendOtp} disabled={isSending}>
            {isSending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Enviar código OTP
          </Button>
        ) : (
          <div className="space-y-2">
            <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-lg p-2 text-center">
              <p className="text-[10px] text-amber-700 dark:text-amber-400">Simulación: El código es</p>
              <p className="text-lg font-mono font-bold text-amber-700 dark:text-amber-400">{displayCode}</p>
            </div>
            <div className="flex gap-2">
              <Input
                value={inputCode}
                onChange={(e) => setInputCode(e.target.value)}
                placeholder="Ingresa el código"
                className="font-mono text-center"
                maxLength={6}
                data-testid="input-otp-code"
              />
              <Button size="sm" onClick={verifyOtp} disabled={inputCode.length < 4} data-testid="button-verify-otp">
                Verificar
              </Button>
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

      setTimeout(async () => {
        try {
          const simulated = OCR_TEMPLATES[docType] || { status: "capturado" };
          setOcrResult(simulated);
          setEditedData(simulated);
          setShowOcr(true);

          await apiSaveDocument({
            originationId,
            tipo: docType,
            imageData: dataUrl,
            ocrResult: JSON.stringify(simulated),
            ocrConfidence: "media",
            editedData: JSON.stringify(simulated),
            status: "ocr_done",
          });

          toast({ title: "Documento analizado", description: `${label} procesado (simulado)` });
          onCaptured();
        } catch (err: any) {
          toast({ title: "Error", description: err.message || "No se pudo procesar", variant: "destructive" });
        } finally {
          setIsAnalyzing(false);
        }
      }, 600);
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
    <Card className={isDone ? "border-emerald-200 dark:border-emerald-800" : ""}>
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
      <Card>
        <CardContent className="p-4 space-y-2">
          <h3 className="text-sm font-medium">Folio Creado</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div><span className="text-muted-foreground">Folio:</span> <strong>{origination.folio}</strong></div>
            <div><span className="text-muted-foreground">Tipo:</span> <strong>{origination.tipo === "validacion" ? "Validación" : "Compraventa"}</strong></div>
            <div><span className="text-muted-foreground">Perfil:</span> <strong>{origination.perfilTipo}</strong></div>
            <div><span className="text-muted-foreground">Creado:</span> <strong>{formatDate(origination.createdAt)}</strong></div>
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
    const step3Keys = ["concesion", "estado_cuenta", "historial_gnv"].filter((key) => {
      if (key === "historial_gnv" && origination.perfilTipo !== "A") return false;
      return true;
    });
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Documentos Taxi</h3>
        <p className="text-xs text-muted-foreground">
          {readOnly
            ? "Revisión de documentos de taxi"
            : "Todos los documentos fueron capturados en el paso anterior. Aquí puedes revisarlos."}
        </p>
        <DocumentSummary origination={origination} docs={docs} stepKeys={step3Keys} />
      </div>
    );
  }

  if (step === 4) {
    const step4Keys = ["factura_vehiculo", "carta_membresia"].filter((key) => {
      if (key === "carta_membresia" && origination.perfilTipo !== "A") return false;
      return true;
    });
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Documentos Vehículo</h3>
        <p className="text-xs text-muted-foreground">
          {readOnly
            ? "Revisión de documentos del vehículo"
            : "Todos los documentos fueron capturados en el paso anterior. Aquí puedes revisarlos."}
        </p>
        <DocumentSummary origination={origination} docs={docs} stepKeys={step4Keys} />
      </div>
    );
  }

  if (step === 5) {
    return (
      <div className="space-y-4">
        <h3 className="text-sm font-medium">Verificación</h3>
        <p className="text-xs text-muted-foreground">Selfie con INE, verificación de teléfono y fotos del vehículo</p>

        <DocumentCapture
          originationId={origination.id}
          docType="selfie_ine"
          label="Selfie con INE"
          existingDoc={getDoc("selfie_ine")}
          onCaptured={refreshAll}
          readOnly={readOnly}
        />

        <OtpVerification
          origination={origination}
          onVerified={refreshAll}
          readOnly={readOnly}
          onUpdate={onUpdate}
        />

        <h4 className="text-xs font-medium text-muted-foreground pt-2">Fotos del Vehículo</h4>
        <div className="grid grid-cols-2 gap-3">
          {(["vehiculo_frente", "vehiculo_lateral_izq", "vehiculo_lateral_der", "vehiculo_trasera"] as DocumentType[]).map((docType) => (
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
        <div className="text-center space-y-2">
          <Loader2 className="w-8 h-8 text-muted-foreground mx-auto animate-spin" />
          <p className="text-sm text-muted-foreground">Cargando folio...</p>
        </div>
      </div>
    );
  }

  if (!origination) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <FileText className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Folio no encontrado</p>
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
        <Link href="/originacion" className="p-1.5 rounded-md hover:bg-muted transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono font-medium">{origination.folio}</span>
            <Badge variant="outline" className="text-[10px]">
              {origination.tipo === "validacion" ? "Validación" : "Compraventa"}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              Perfil {origination.perfilTipo}
            </Badge>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Creado: {formatDate(origination.createdAt)}
          </p>
        </div>
      </div>

      {/* Progress + Navigable Stepper */}
      <div className="space-y-2">
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
          <span className="text-muted-foreground">{Math.round(progress)}%</span>
        </div>
        <Progress value={progress} className="h-1.5" />
        <div className="flex justify-between">
          {ORIGINATION_STEPS.map((s) => (
            <button
              key={s.step}
              onClick={() => handleStepClick(s.step)}
              className={`w-8 h-8 rounded-full text-[10px] font-medium flex items-center justify-center transition-all ${
                s.step < currentStep
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 cursor-pointer hover:ring-2 hover:ring-emerald-400"
                  : s.step === currentStep
                  ? "bg-primary text-primary-foreground"
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
            className="text-xs text-primary font-medium hover:underline"
            data-testid="button-back-to-current"
          >
            ← Volver al paso actual ({currentStep})
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
              className="w-full gap-2"
              onClick={() => advanceStep(2)}
              data-testid="button-start-capture"
            >
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
