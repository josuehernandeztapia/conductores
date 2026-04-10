/**
 * ExpedienteSemaforo — Consolidated validation status per folio
 * Shows which cross-check validations passed/failed per document,
 * with specific field and reason (vencido, no coincide, ilegible).
 */

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, AlertTriangle, FileText } from "lucide-react";
import { apiGetDocuments } from "@/lib/api";

interface DocValidation {
  docKey: string;
  docLabel: string;
  status: "ok" | "warning" | "error" | "pending";
  flags: string[];
  extractedFields?: Record<string, any>;
}

interface SemaforoProps {
  originationId: number;
  token?: string; // optional, uses apiFetch internally
}

// Human-readable flag descriptions
const FLAG_DESCRIPTIONS: Record<string, string> = {
  nombre_mismatch: "Nombre no coincide con INE",
  curp_mismatch: "CURP no coincide con INE",
  niv_mismatch: "NIV no coincide con tarjeta",
  placa_mismatch: "Placa no coincide con tarjeta",
  placa_mismatch_gnv: "Placa del ticket no coincide con tarjeta",
  domicilio_mismatch: "Domicilio no coincide con INE",
  domicilio_vencido: "Comprobante de domicilio vencido (+3 meses)",
  csf_vencida: "CSF vencida (+30 días)",
  ine_vencida: "INE vencida",
  ine_operador_vencida: "INE del operador vencida",
  licencia_vencida: "Licencia de conducir vencida",
  expired: "Documento vencido",
  clabe_invalid: "CLABE inválida (debe ser 18 dígitos)",
  no_es_taxi: "Tarjeta de circulación NO es taxi (RECHAZO)",
  tipo_no_taxi: "Concesión NO es de taxi (RECHAZO)",
  municipio_no_ags: "Concesión fuera de Aguascalientes (RECHAZO)",
  rostro_no_coincide: "Rostro en selfie no coincide con INE",
  misma_persona_que_titular: "INE operador es la misma persona que el titular",
  consumo_bajo_gnv: "Consumo GNV bajo (<300 LEQ/mes)",
  gasto_bajo_gasolina: "Gasto gasolina bajo (<$6,000/mes)",
  ilegible: "Documento ilegible o borroso",
};

const DOC_LABELS: Record<string, string> = {
  ine_frente: "INE Frente",
  ine_reverso: "INE Reverso",
  licencia: "Licencia de Conducir",
  factura_vehiculo: "Factura del Vehículo",
  csf: "Constancia Situación Fiscal",
  comprobante_domicilio: "Comprobante de Domicilio",
  tarjeta_circulacion: "Tarjeta de Circulación",
  concesion: "Concesión de Taxi",
  estado_cuenta: "Estado de Cuenta",
  historial_gnv: "Historial GNV",
  tickets_gasolina: "Tickets Gasolina",
  carta_membresia: "Carta Membresía",
  selfie_ine: "Selfie con INE",
  ine_operador: "INE del Operador",
  fotos_unidad: "Fotos de la Unidad",
};

const REJECTION_FLAGS = new Set(["no_es_taxi", "tipo_no_taxi", "municipio_no_ags"]);

export function ExpedienteSemaforo({ originationId, token }: SemaforoProps) {
  const [validations, setValidations] = useState<DocValidation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!originationId) return;
    fetchValidations();
  }, [originationId]);

  async function fetchValidations() {
    setLoading(true);
    try {
      const docs: any[] = await apiGetDocuments(originationId);

      const vals: DocValidation[] = docs.map((doc) => {
        const flags: string[] = [];

        // Parse flags from ocr_confidence field (stored as JSON array of flags)
        let ocrFlags: string[] = [];
        try {
          const conf = doc.ocrConfidence || doc.ocr_confidence;
          if (conf) ocrFlags = JSON.parse(conf);
        } catch {}

        // Parse flags from ocr_result
        try {
          const result = doc.ocrResult || doc.ocr_result;
          if (result) {
            const parsed = JSON.parse(result);
            if (Array.isArray(parsed.cross_check_flags)) {
              ocrFlags.push(...parsed.cross_check_flags);
            }
          }
        } catch {}

        flags.push(...ocrFlags);

        const hasRejection = flags.some((f) => REJECTION_FLAGS.has(f));
        const hasError = flags.some(
          (f) =>
            f.includes("mismatch") ||
            f.includes("invalid") ||
            f.includes("vencid") ||
            f.includes("expired") ||
            f === "ilegible" ||
            REJECTION_FLAGS.has(f)
        );
        const hasWarning = flags.some(
          (f) => f.includes("bajo") || f.includes("consumo")
        );

        let status: "ok" | "warning" | "error" | "pending" = "ok";
        if (hasRejection || hasError) status = "error";
        else if (hasWarning) status = "warning";

        const tipo = doc.tipo || doc.type || "otro";

        return {
          docKey: tipo,
          docLabel: DOC_LABELS[tipo] || tipo,
          status,
          flags,
          extractedFields: (() => {
            try {
              const r = doc.ocrResult || doc.ocr_result;
              return r ? JSON.parse(r) : {};
            } catch {
              return {};
            }
          })(),
        };
      });

      setValidations(vals);
    } catch (e) {
      console.error("Semáforo error:", e);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="text-xs text-muted-foreground p-2">Cargando validaciones…</div>
    );
  }

  if (validations.length === 0) {
    return (
      <div className="text-xs text-muted-foreground p-2">
        Sin documentos capturados aún.
      </div>
    );
  }

  const errors = validations.filter((v) => v.status === "error");
  const warnings = validations.filter((v) => v.status === "warning");
  const ok = validations.filter((v) => v.status === "ok");

  // Overall status
  const overallStatus =
    errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "ok";

  return (
    <div className="space-y-2">
      {/* Summary badges */}
      <div className="flex gap-2 flex-wrap items-center">
        <span className="text-xs font-medium text-muted-foreground">Validaciones:</span>
        {ok.length > 0 && (
          <Badge
            variant="outline"
            className="text-[10px] gap-1 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-800"
          >
            <CheckCircle2 className="w-2.5 h-2.5" />
            {ok.length} correctos
          </Badge>
        )}
        {warnings.length > 0 && (
          <Badge
            variant="outline"
            className="text-[10px] gap-1 text-amber-700 border-amber-200 dark:text-amber-400 dark:border-amber-800"
          >
            <AlertTriangle className="w-2.5 h-2.5" />
            {warnings.length} advertencias
          </Badge>
        )}
        {errors.length > 0 && (
          <Badge
            variant="outline"
            className="text-[10px] gap-1 text-red-700 border-red-200 dark:text-red-400 dark:border-red-800"
          >
            <XCircle className="w-2.5 h-2.5" />
            {errors.length} errores
          </Badge>
        )}
      </div>

      {/* Per-document list */}
      <div className="rounded-md border divide-y text-[11px]">
        {validations.map((v, i) => (
          <div key={i} className="px-3 py-2">
            <div className="flex items-center gap-2">
              {v.status === "ok" && (
                <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />
              )}
              {v.status === "warning" && (
                <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
              )}
              {v.status === "error" && (
                <XCircle className="w-3 h-3 text-red-500 shrink-0" />
              )}
              {v.status === "pending" && (
                <FileText className="w-3 h-3 text-muted-foreground shrink-0" />
              )}
              <span className="font-medium">{v.docLabel}</span>
            </div>

            {/* Flag details */}
            {v.flags.length > 0 && (
              <div className="mt-1 ml-5 space-y-0.5">
                {v.flags.map((flag, fi) => {
                  const isRejection = REJECTION_FLAGS.has(flag);
                  return (
                    <div
                      key={fi}
                      className={`text-[10px] ${
                        isRejection
                          ? "text-red-600 font-semibold"
                          : flag.includes("bajo")
                          ? "text-amber-600"
                          : "text-red-500"
                      }`}
                    >
                      {isRejection && "⛔ "}
                      {FLAG_DESCRIPTIONS[flag] || flag}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
