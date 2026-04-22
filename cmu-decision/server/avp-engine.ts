/**
 * AVP Engine — Aviso de Privacidad Integral (LFPDPPP)
 *
 * Gestiona la aceptación, el registro con sello de tiempo y el historial
 * de versiones del Aviso de Privacidad firmado por cada Operador.
 *
 * Base legal:
 *   - LFPDPPP art. 8 (consentimiento), 9 (datos sensibles), 16 (aviso integral),
 *     32 (respuesta ARCO en 20 días hábiles).
 *   - Código de Comercio art. 89-bis (valor probatorio de firma electrónica).
 *   - NOM-151 (conservación de mensajes de datos con constancia NOM).
 */

import { neon } from "@neondatabase/serverless";
import { AVP_CURRENT_VERSION, AVP_VIGENTE_DESDE } from "@shared/schema";
import { generateAVP, docxToPdf } from "./contract-engine";

const getSQL = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("No DATABASE_URL");
  return neon(url);
};

export interface AvpAcceptanceInput {
  phone: string;
  operadorNombre?: string | null;
  operadorIne?: string | null;
  operadorCurp?: string | null;
  folioVal?: string | null;
  originationId?: number | null;
  consentSecundarias: boolean;
  otpSid?: string | null;
  ipAceptacion?: string | null;
  userAgent?: string | null;
}

export interface AvpAcceptanceRecord {
  id: number;
  folio: string;
  version: string;
  phone: string;
  operador_nombre: string | null;
  operador_ine: string | null;
  operador_curp: string | null;
  folio_val: string | null;
  origination_id: number | null;
  consent_secundarias: number;
  otp_sid: string | null;
  ip_aceptacion: string | null;
  user_agent: string | null;
  accepted_at: string;
  revoked_at: string | null;
}

/**
 * Inicializa la tabla avp_acceptances si no existe.
 * Debe llamarse en el bootstrap del server (similar a initAuditTable).
 */
export async function initAvpTable(): Promise<void> {
  const sql = getSQL();
  await sql`
    CREATE TABLE IF NOT EXISTS avp_acceptances (
      id SERIAL PRIMARY KEY,
      folio TEXT NOT NULL,
      version TEXT NOT NULL,
      phone TEXT NOT NULL,
      operador_nombre TEXT,
      operador_ine TEXT,
      operador_curp TEXT,
      folio_val TEXT,
      origination_id INTEGER,
      consent_secundarias INTEGER NOT NULL DEFAULT 0,
      otp_sid TEXT,
      ip_aceptacion TEXT,
      user_agent TEXT,
      pdf_base64 TEXT,
      accepted_at TEXT NOT NULL,
      revoked_at TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_avp_phone ON avp_acceptances(phone)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_avp_accepted_at ON avp_acceptances(accepted_at DESC)`;
  console.log("[AVP] Table avp_acceptances created/verified");
}

/** Genera un folio AVP con fecha y secuencia. */
async function nextFolio(): Promise<string> {
  const sql = getSQL();
  const today = new Date();
  const ymd = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, "0")}${String(today.getUTCDate()).padStart(2, "0")}`;
  const prefix = `CMU-AVP-${ymd}-`;
  try {
    const rows = await sql`
      SELECT folio FROM avp_acceptances
      WHERE folio LIKE ${prefix + "%"}
      ORDER BY id DESC LIMIT 1
    ` as Array<{ folio: string }>;
    let next = 1;
    if (rows.length > 0) {
      const m = rows[0].folio.match(/(\d+)$/);
      if (m) next = parseInt(m[1], 10) + 1;
    }
    return `${prefix}${String(next).padStart(3, "0")}`;
  } catch {
    return `${prefix}001`;
  }
}

/**
 * Registra una aceptación del AVP. Devuelve el registro creado con su folio
 * y el PDF de constancia congelado en base64 (prueba documental).
 */
export async function recordAcceptance(input: AvpAcceptanceInput): Promise<{
  folio: string;
  version: string;
  acceptedAt: string;
  pdfBase64: string;
}> {
  const sql = getSQL();
  const folio = await nextFolio();
  const acceptedAt = new Date().toISOString();
  const version = AVP_CURRENT_VERSION;

  // Build a frozen PDF of the accepted document (legal proof).
  // We pass all acceptance metadata into the DOCX template so the proof
  // renders with exact time, phone, OTP SID, IP, etc.
  let pdfBase64 = "";
  try {
    const fakeOrig = {
      folio,
      folio_val: input.folioVal || "",
    };
    const fakeTaxista = {
      nombre: input.operadorNombre || "",
      apellidoPaterno: "",
      apellidoMaterno: "",
      curp: input.operadorCurp || "",
      ine_numero: input.operadorIne || "",
      telefono: input.phone,
    };
    const docxBuffer = await generateAVP(fakeOrig, fakeTaxista, {
      folio_avp: folio,
      version,
      vigente_desde: AVP_VIGENTE_DESDE,
      fecha_aceptacion: acceptedAt,
      otp_sid: input.otpSid || "N/A",
      ip_aceptacion: input.ipAceptacion || "N/A",
      user_agent: input.userAgent || "N/A",
      consent_secundarias: input.consentSecundarias ? "Sí (aceptadas)" : "No (rechazadas por el Titular)",
    });
    const pdfBuffer = await docxToPdf(docxBuffer);
    pdfBase64 = pdfBuffer.toString("base64");
  } catch (e: any) {
    console.error(`[AVP] PDF generation failed for ${folio}: ${e.message}`);
    // We still record the acceptance — absence of PDF does not void consent.
  }

  await sql`
    INSERT INTO avp_acceptances (
      folio, version, phone, operador_nombre, operador_ine, operador_curp,
      folio_val, origination_id, consent_secundarias, otp_sid,
      ip_aceptacion, user_agent, pdf_base64, accepted_at
    ) VALUES (
      ${folio},
      ${version},
      ${input.phone},
      ${input.operadorNombre || null},
      ${input.operadorIne || null},
      ${input.operadorCurp || null},
      ${input.folioVal || null},
      ${input.originationId || null},
      ${input.consentSecundarias ? 1 : 0},
      ${input.otpSid || null},
      ${input.ipAceptacion || null},
      ${input.userAgent || null},
      ${pdfBase64 || null},
      ${acceptedAt}
    )
  `;

  console.log(`[AVP] Accepted ${folio} by ${input.phone} (version ${version})`);
  return { folio, version, acceptedAt, pdfBase64 };
}

/**
 * Última aceptación del AVP por el teléfono. Devuelve null si nunca aceptó
 * o si está revocada. Incluye si la versión aceptada es la actual.
 */
export async function getLatestAcceptance(phone: string): Promise<{
  record: AvpAcceptanceRecord;
  isCurrent: boolean;
} | null> {
  const sql = getSQL();
  const rows = await sql`
    SELECT id, folio, version, phone, operador_nombre, operador_ine, operador_curp,
           folio_val, origination_id, consent_secundarias, otp_sid,
           ip_aceptacion, user_agent, accepted_at, revoked_at
    FROM avp_acceptances
    WHERE phone = ${phone} AND revoked_at IS NULL
    ORDER BY accepted_at DESC
    LIMIT 1
  ` as AvpAcceptanceRecord[];
  if (rows.length === 0) return null;
  const record = rows[0];
  return { record, isCurrent: record.version === AVP_CURRENT_VERSION };
}

/** Revoca la aceptación vigente de un teléfono (derecho ARCO - cancelación). */
export async function revokeAcceptance(phone: string): Promise<boolean> {
  const sql = getSQL();
  const now = new Date().toISOString();
  const result = await sql`
    UPDATE avp_acceptances
    SET revoked_at = ${now}
    WHERE phone = ${phone} AND revoked_at IS NULL
  `;
  console.log(`[AVP] Revoked acceptance for ${phone}`);
  return true;
}

/** Verifica si un teléfono tiene una aceptación vigente y al día. */
export async function hasValidAcceptance(phone: string): Promise<boolean> {
  const latest = await getLatestAcceptance(phone);
  return latest !== null && latest.isCurrent;
}
