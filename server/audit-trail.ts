/**
 * Audit Trail — Log de acciones para compliance financiera
 * 
 * Registra: login, crear folio, editar inventario, aprobar/rechazar evaluación,
 * generar contrato, firmar, cambios de estado.
 * 
 * Tabla: audit_log en Neon
 */

import { neon } from "@neondatabase/serverless";

const getSQL = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("No DATABASE_URL");
  return neon(url);
};

export type AuditAction =
  | "LOGIN"
  | "LOGIN_FAILED"
  | "LOGOUT"
  | "FOLIO_CREATED"
  | "FOLIO_STEP_ADVANCED"
  | "FOLIO_UPDATED"
  | "VEHICLE_CREATED"
  | "VEHICLE_UPDATED"
  | "EVAL_SUBMITTED"
  | "EVAL_APPROVED"
  | "EVAL_REJECTED"
  | "CONTRACT_GENERATED"
  | "CONTRACT_SIGNED"
  | "PAYMENT_REGISTERED"
  | "CIERRE_EXECUTED"
  | "CONFIG_CHANGED";

export interface AuditEntry {
  action: AuditAction;
  actor: string;         // "Ángeles Mireles" or "Josué Hernández" or "system" or IP
  role: string;          // "promotora" | "director" | "system" | "cron"
  target_type?: string;  // "folio" | "vehicle" | "evaluacion" | "config"
  target_id?: string;    // folio ID, vehicle ID, etc
  details?: string;      // JSON or description
  ip?: string;
}

export async function initAuditTable(): Promise<void> {
  const sql = getSQL();
  await sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'system',
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      ip TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // Index for fast queries by action and date
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)`;
  console.log("[Audit] Table audit_log created/verified");
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    const sql = getSQL();
    await sql`
      INSERT INTO audit_log (action, actor, role, target_type, target_id, details, ip)
      VALUES (
        ${entry.action},
        ${entry.actor},
        ${entry.role},
        ${entry.target_type || null},
        ${entry.target_id || null},
        ${entry.details || null},
        ${entry.ip || null}
      )
    `;
  } catch (err: any) {
    // Non-blocking — audit failures should not break the app
    console.error(`[Audit] Failed to log ${entry.action}: ${err.message}`);
  }
}

export async function getAuditLog(options?: {
  limit?: number;
  action?: string;
  actor?: string;
  target_type?: string;
  target_id?: string;
}): Promise<any[]> {
  const sql = getSQL();
  const limit = options?.limit || 100;

  if (options?.action) {
    return sql`SELECT * FROM audit_log WHERE action = ${options.action} ORDER BY created_at DESC LIMIT ${limit}`;
  }
  if (options?.target_id) {
    return sql`SELECT * FROM audit_log WHERE target_id = ${options.target_id} ORDER BY created_at DESC LIMIT ${limit}`;
  }
  if (options?.actor) {
    return sql`SELECT * FROM audit_log WHERE actor = ${options.actor} ORDER BY created_at DESC LIMIT ${limit}`;
  }
  return sql`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ${limit}`;
}
