/**
 * OCR Provenance Log
 *
 * Implementa el compromiso de trazabilidad interna declarado en la
 * Cl\u00e1usula V bis inciso c) del Aviso de Privacidad Integral v3:
 *
 *   "CMU mantiene, en su base de datos interna, un registro del proveedor
 *    espec\u00edfico que proces\u00f3 cada documento OCR, la versi\u00f3n del Aviso de
 *    Privacidad vigente al momento del procesamiento, y la marca temporal
 *    correspondiente, para efectos de auditor\u00eda y atenci\u00f3n a solicitudes ARCO."
 *
 * Registra cada llamada de OCR por proveedor (OpenAI / Anthropic) para
 * permitir responder solicitudes de acceso y detectar usos anormales.
 */

import { neon } from "@neondatabase/serverless";
import { AVP_CURRENT_VERSION } from "@shared/schema";

const getSQL = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("No DATABASE_URL");
  return neon(url);
};

export type OcrProvider = "openai" | "anthropic";
export type OcrStatus = "success" | "error" | "fallback_used";

export interface OcrLogInput {
  phone?: string | null;
  originationId?: number | null;
  documentType?: string | null;
  provider: OcrProvider;
  providerModel?: string | null;
  status: OcrStatus;
  errorMessage?: string | null;
}

let tableReady = false;

export async function initOcrProvenanceTable(): Promise<void> {
  const sql = getSQL();
  await sql`
    CREATE TABLE IF NOT EXISTS ocr_processing_log (
      id SERIAL PRIMARY KEY,
      phone TEXT,
      origination_id INTEGER,
      document_type TEXT,
      provider TEXT NOT NULL,
      provider_model TEXT,
      avp_version_at_processing TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      processed_at TEXT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_ocr_phone ON ocr_processing_log(phone)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ocr_processed_at ON ocr_processing_log(processed_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ocr_provider ON ocr_processing_log(provider)`;
  tableReady = true;
  console.log("[OcrProvenance] Table ocr_processing_log created/verified");
}

/**
 * Registra una llamada de OCR. Es non-blocking: si la escritura falla,
 * loguea el error pero no rompe el flujo OCR (el compromiso legal es
 * mantener el registro, pero perder un log por fallo de BD no debe romper
 * el procesamiento del documento).
 */
export async function logOcrCall(input: OcrLogInput): Promise<void> {
  try {
    if (!tableReady) {
      // Best-effort: try to init if the module was imported before bootstrap
      await initOcrProvenanceTable().catch(() => { /* ignore */ });
    }
    const sql = getSQL();
    const processedAt = new Date().toISOString();
    await sql`
      INSERT INTO ocr_processing_log (
        phone, origination_id, document_type, provider, provider_model,
        avp_version_at_processing, status, error_message, processed_at
      ) VALUES (
        ${input.phone || null},
        ${input.originationId || null},
        ${input.documentType || null},
        ${input.provider},
        ${input.providerModel || null},
        ${AVP_CURRENT_VERSION},
        ${input.status},
        ${input.errorMessage || null},
        ${processedAt}
      )
    `;
  } catch (e: any) {
    // Non-blocking \u2014 log but do not throw.
    console.error(`[OcrProvenance] Failed to record OCR call: ${e.message}`);
  }
}

/**
 * Consulta el historial de procesamiento OCR para un tel\u00e9fono.
 * Se usa al atender solicitudes ARCO-acceso del operador.
 */
export async function getOcrHistoryForPhone(phone: string, limit = 500) {
  const sql = getSQL();
  return await sql`
    SELECT id, phone, origination_id, document_type, provider, provider_model,
           avp_version_at_processing, status, processed_at
    FROM ocr_processing_log
    WHERE phone = ${phone}
    ORDER BY processed_at DESC
    LIMIT ${limit}
  `;
}
