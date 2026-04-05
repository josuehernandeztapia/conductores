/**
 * Proactive Agent — Cron-triggered WhatsApp reminders
 *
 * Functions called by /api/cron/proactive to send proactive messages:
 * - Stale expedientes (no doc uploads for 3+ days)
 * - Pending payments (Airtable: Pagos.Estatus = 'Pendiente')
 * - Upcoming deadlines (concesion vigencia, anticipo deadline)
 *
 * SQL for proactive message log table:
 * CREATE TABLE IF NOT EXISTS proactive_messages (
 *   id SERIAL PRIMARY KEY,
 *   phone TEXT NOT NULL,
 *   message_type TEXT NOT NULL,
 *   folio TEXT,
 *   sent_at TIMESTAMP DEFAULT NOW(),
 *   message_text TEXT
 * );
 */

import type { IStorage } from "./storage";
import { neon } from "@neondatabase/serverless";
import { isAirtableEnabled, getAllCredits } from "./airtable-client";

type SendWaFn = (to: string, body: string) => Promise<any>;

// ===== Known phones =====
import { getPromotor, DIRECTOR } from "./team-config";
const PROMOTOR_1 = getPromotor();
const PROMOTOR_1_PHONE = PROMOTOR_1?.phone || "5214493845228";
const JOSUE_PHONE = "5214422022540";

// ===== Helpers =====

function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  return neon(url);
}

async function logProactiveMessage(
  phone: string,
  messageType: string,
  folio: string | null,
  messageText: string,
): Promise<void> {
  try {
    const sql = getSql();
    await sql`
      INSERT INTO proactive_messages (phone, message_type, folio, message_text)
      VALUES (${phone}, ${messageType}, ${folio}, ${messageText})
    `;
  } catch (e: any) {
    // Table might not exist yet — log but don't fail
    console.warn("[Proactive] Could not log message:", e.message);
  }
}

async function wasMessageSentRecently(
  phone: string,
  messageType: string,
  withinHours: number = 24,
): Promise<boolean> {
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT id FROM proactive_messages
      WHERE phone = ${phone}
        AND message_type = ${messageType}
        AND sent_at > NOW() - INTERVAL '1 hour' * ${withinHours}
      LIMIT 1
    `;
    return rows.length > 0;
  } catch {
    return false; // If table doesn't exist, allow sending
  }
}

// ===== Check Stale Expedientes =====

/**
 * Find originations stuck in CAPTURANDO/BORRADOR for 3+ days.
 * Send reminder to promotor. If > 7 days, also remind taxista.
 */
export async function checkStaleExpedientes(
  storage: IStorage,
  sendWa: SendWaFn,
): Promise<{ reminded: number; errors: string[] }> {
  let reminded = 0;
  const errors: string[] = [];

  try {
    const sql = getSql();
    // Find stale originations
    const staleOrigs = await sql`
      SELECT o.id, o.folio, o.estado, o.updated_at, o.otp_phone,
             t.nombre, t.apellido_paterno, t.telefono as taxista_phone
      FROM originations o
      LEFT JOIN taxistas t ON o.taxista_id = t.id
      WHERE o.estado IN ('CAPTURANDO', 'BORRADOR')
        AND o.updated_at < NOW() - INTERVAL '3 days'
      ORDER BY o.updated_at ASC
      LIMIT 20
    `;

    for (const orig of staleOrigs) {
      const folio = orig.folio;
      const taxistaName = [orig.nombre, orig.apellido_paterno].filter(Boolean).join(" ") || "taxista";
      const daysSince = Math.floor((Date.now() - new Date(orig.updated_at).getTime()) / (1000 * 60 * 60 * 24));

      // Always remind promotor — max once per 24h per folio
      const promotorKey = `stale_promotor_${folio}`;
      const alreadySentPromotor = await wasMessageSentRecently(PROMOTOR_1_PHONE, promotorKey, 24);
      if (!alreadySentPromotor) {
        const msg = `📋 *Recordatorio: Expediente pendiente*\n\nFolio: *${folio}*\nNombre: ${taxistaName}\nEstado: ${orig.estado}\nÚltima actividad: hace ${daysSince} días\n\n¿Necesitas ayuda para completar los documentos?`;
        try {
          await sendWa(`whatsapp:+${PROMOTOR_1_PHONE}`, msg);
          await logProactiveMessage(PROMOTOR_1_PHONE, promotorKey, folio, msg);
          reminded++;
        } catch (e: any) {
          errors.push(`promotor ${folio}: ${e.message}`);
        }
      }

      // If > 7 days, also remind taxista
      if (daysSince >= 7) {
        const taxistaPhone = orig.taxista_phone || orig.otp_phone;
        if (taxistaPhone) {
          const cleanPhone = taxistaPhone.replace(/[^0-9]/g, "");
          const taxistaKey = `stale_taxista_${folio}`;
          const alreadySentTaxista = await wasMessageSentRecently(cleanPhone, taxistaKey, 48);
          if (!alreadySentTaxista) {
            const msg = `👋 Hola ${taxistaName}, soy el asistente de CMU.\n\nTu expediente *${folio}* tiene documentos pendientes. ¿Necesitas ayuda?\n\nPuedes enviarme los documentos faltantes por aquí o contactar a tu asesora promotor.`;
            try {
              await sendWa(`whatsapp:+${cleanPhone}`, msg);
              await logProactiveMessage(cleanPhone, taxistaKey, folio, msg);
              reminded++;
            } catch (e: any) {
              errors.push(`taxista ${folio}: ${e.message}`);
            }
          }
        }
      }
    }
  } catch (e: any) {
    errors.push(`query: ${e.message}`);
  }

  return { reminded, errors };
}

// ===== Check Pending Payments =====

/**
 * Query Airtable for credits with pending payments or days overdue.
 * Send reminders to taxista and/or promotor.
 */
export async function checkPendingPayments(
  sendWa: SendWaFn,
): Promise<{ reminded: number; errors: string[] }> {
  let reminded = 0;
  const errors: string[] = [];

  if (!isAirtableEnabled()) {
    return { reminded: 0, errors: ["Airtable not configured"] };
  }

  try {
    const credits = await getAllCredits();
    for (const credit of credits) {
      const c = credit as any;
      const diasAtraso = c.Dias_Atraso || c.dias_atraso || 0;
      const folio = c.Folio || c.folio || "";
      const taxistaName = c.Taxista || c.taxista || "";
      const phone = c.Telefono || c.telefono || "";

      if (diasAtraso <= 0 || !phone) continue;

      const cleanPhone = phone.replace(/[^0-9]/g, "");
      if (!cleanPhone) continue;

      // Determine urgency
      let urgency: string;
      let emoji: string;
      if (diasAtraso >= 15) {
        urgency = "urgente";
        emoji = "🔴";
      } else if (diasAtraso >= 7) {
        urgency = "importante";
        emoji = "🟡";
      } else {
        urgency = "leve";
        emoji = "🟢";
      }

      // Send to taxista — max once per 48h
      const payKey = `payment_${folio}_${diasAtraso > 14 ? "urgent" : "normal"}`;
      const alreadySent = await wasMessageSentRecently(cleanPhone, payKey, 48);
      if (!alreadySent) {
        const msg = `${emoji} *Recordatorio de pago CMU*\n\nHola ${taxistaName}, tu crédito *${folio}* tiene *${diasAtraso} días de atraso*.\n\nPuedes realizar tu pago por transferencia a:\nCLABE: 152680120000787681\nBanco: Bancrea\nRazón Social: Conductores del Mundo, S.A.P.I. de C.V.\n\n¿Necesitas ayuda?`;
        try {
          await sendWa(`whatsapp:+${cleanPhone}`, msg);
          await logProactiveMessage(cleanPhone, payKey, folio, msg);
          reminded++;
        } catch (e: any) {
          errors.push(`taxista payment ${folio}: ${e.message}`);
        }
      }

      // QW-4: Escalate to director when dias atraso > 5 (was 15)
      if (diasAtraso > 5) {
        const dirKey = `payment_director_${folio}_${diasAtraso > 14 ? "critical" : "warning"}`;
        const cooldown = diasAtraso > 14 ? 24 : 48; // critical = daily, warning = every 48h
        const alreadySentDir = await wasMessageSentRecently(JOSUE_PHONE, dirKey, cooldown);
        if (!alreadySentDir) {
          const dirEmoji = diasAtraso > 14 ? "🔴" : diasAtraso > 7 ? "🟡" : "🟠";
          const dirUrgency = diasAtraso > 14 ? "CRÍTICO" : diasAtraso > 7 ? "IMPORTANTE" : "ATENCIÓN";
          const dirMsg = `${dirEmoji} *${dirUrgency} — Atraso ${diasAtraso}d*\nFolio: ${folio}\nTaxista: ${taxistaName}\nTel: ${phone}\n${diasAtraso > 14 ? "Requiere acción INMEDIATA." : "Dar seguimiento esta semana."}`;
          try {
            await sendWa(`whatsapp:+${JOSUE_PHONE}`, dirMsg);
            await logProactiveMessage(JOSUE_PHONE, dirKey, folio, dirMsg);
          } catch (e: any) {
            errors.push(`director payment ${folio}: ${e.message}`);
          }
        }
      }
    }
  } catch (e: any) {
    errors.push(`airtable: ${e.message}`);
  }

  return { reminded, errors };
}

// ===== Check Upcoming Deadlines =====

/**
 * Check for:
 * - Concesion vigencia expiring soon
 * - Anticipo deadline (day 50 of 56-day window)
 */
export async function checkUpcomingDeadlines(
  storage: IStorage,
  sendWa: SendWaFn,
): Promise<{ reminded: number; errors: string[] }> {
  let reminded = 0;
  const errors: string[] = [];

  try {
    const sql = getSql();

    // Check anticipo deadlines: originations in FIRMADO state where
    // contract was signed ~50 days ago (anticipo due by day 56)
    const nearDeadline = await sql`
      SELECT o.id, o.folio, o.contract_generated_at, o.estado,
             t.nombre, t.apellido_paterno, t.telefono
      FROM originations o
      LEFT JOIN taxistas t ON o.taxista_id = t.id
      WHERE o.estado = 'FIRMADO'
        AND o.contract_generated_at IS NOT NULL
        AND o.contract_generated_at < NOW() - INTERVAL '50 days'
        AND o.contract_generated_at > NOW() - INTERVAL '56 days'
      LIMIT 10
    `;

    for (const orig of nearDeadline) {
      const folio = orig.folio;
      const taxistaName = [orig.nombre, orig.apellido_paterno].filter(Boolean).join(" ") || "taxista";
      const phone = orig.telefono;
      if (!phone) continue;

      const cleanPhone = phone.replace(/[^0-9]/g, "");
      const deadlineKey = `anticipo_deadline_${folio}`;
      const alreadySent = await wasMessageSentRecently(cleanPhone, deadlineKey, 48);
      if (!alreadySent) {
        const daysSince = Math.floor((Date.now() - new Date(orig.contract_generated_at).getTime()) / (1000 * 60 * 60 * 24));
        const daysLeft = Math.max(0, 56 - daysSince);
        const msg = `⏰ *Recordatorio: Anticipo a capital*\n\nHola ${taxistaName}, tu anticipo de $50,000 para el folio *${folio}* vence en *${daysLeft} días*.\n\nCLABE: 152680120000787681\nBanco: Bancrea\nConcepto: Anticipo ${folio}\n\n¿Ya lo realizaste? Envíame tu comprobante.`;
        try {
          await sendWa(`whatsapp:+${cleanPhone}`, msg);
          await logProactiveMessage(cleanPhone, deadlineKey, folio, msg);
          reminded++;
        } catch (e: any) {
          errors.push(`anticipo ${folio}: ${e.message}`);
        }
      }

      // Also notify promotor
      const promKey = `anticipo_promotor_${folio}`;
      const alreadySentProm = await wasMessageSentRecently(PROMOTOR_1_PHONE, promKey, 24);
      if (!alreadySentProm) {
        const daysSince = Math.floor((Date.now() - new Date(orig.contract_generated_at).getTime()) / (1000 * 60 * 60 * 24));
        const daysLeft = Math.max(0, 56 - daysSince);
        const promMsg = `⏰ Anticipo pendiente: *${folio}* (${taxistaName}) — ${daysLeft} días restantes.`;
        try {
          await sendWa(`whatsapp:+${PROMOTOR_1_PHONE}`, promMsg);
          await logProactiveMessage(PROMOTOR_1_PHONE, promKey, folio, promMsg);
        } catch (e: any) {
          errors.push(`anticipo promotor ${folio}: ${e.message}`);
        }
      }
    }

    // Check concesion vigencia expiring within 30 days
    const expiringConcesion = await sql`
      SELECT o.id, o.folio, o.datos_concesion,
             t.nombre, t.apellido_paterno, t.telefono
      FROM originations o
      LEFT JOIN taxistas t ON o.taxista_id = t.id
      WHERE o.estado NOT IN ('RECHAZADO', 'COMPLETADO')
        AND o.datos_concesion IS NOT NULL
      LIMIT 50
    `;

    for (const orig of expiringConcesion) {
      try {
        const concesionData = typeof orig.datos_concesion === "string"
          ? JSON.parse(orig.datos_concesion)
          : orig.datos_concesion;
        const vigencia = concesionData?.vigencia || concesionData?.fecha_vigencia;
        if (!vigencia) continue;

        const vigDate = new Date(vigencia);
        const daysUntil = Math.floor((vigDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        if (daysUntil > 30 || daysUntil < 0) continue;

        const folio = orig.folio;
        const taxistaName = [orig.nombre, orig.apellido_paterno].filter(Boolean).join(" ") || "taxista";
        const phone = orig.telefono;
        if (!phone) continue;

        const cleanPhone = phone.replace(/[^0-9]/g, "");
        const concKey = `concesion_${folio}`;
        const alreadySent = await wasMessageSentRecently(cleanPhone, concKey, 168); // Once per week
        if (!alreadySent) {
          const msg = `📄 *Aviso: Concesión por vencer*\n\nHola ${taxistaName}, tu concesión para *${folio}* vence en *${daysUntil} días*.\n\nPor favor inicia el trámite de renovación lo antes posible.`;
          try {
            await sendWa(`whatsapp:+${cleanPhone}`, msg);
            await logProactiveMessage(cleanPhone, concKey, folio, msg);
            reminded++;
          } catch (e: any) {
            errors.push(`concesion ${folio}: ${e.message}`);
          }
        }
      } catch {
        // datos_concesion might be malformed — skip
      }
    }
  } catch (e: any) {
    errors.push(`query: ${e.message}`);
  }

  return { reminded, errors };
}

/**
 * Run all proactive checks. Called by /api/cron/proactive.
 */
export async function runAllProactiveChecks(
  storage: IStorage,
  sendWa: SendWaFn,
): Promise<{ stale: any; payments: any; deadlines: any }> {
  console.log("[Proactive] Running all checks...");

  const stale = await checkStaleExpedientes(storage, sendWa);
  console.log(`[Proactive] Stale expedientes: ${stale.reminded} reminded, ${stale.errors.length} errors`);

  const payments = await checkPendingPayments(sendWa);
  console.log(`[Proactive] Pending payments: ${payments.reminded} reminded, ${payments.errors.length} errors`);

  const deadlines = await checkUpcomingDeadlines(storage, sendWa);
  console.log(`[Proactive] Deadlines: ${deadlines.reminded} reminded, ${deadlines.errors.length} errors`);

  return { stale, payments, deadlines };
}
