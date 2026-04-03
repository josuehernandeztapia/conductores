/**
 * WhatsApp Template Sender — Uses Twilio Content SIDs for proactive messages
 * 
 * Solves error 63016: "outside the allowed window"
 * All business-initiated messages (outside 24h window) must use approved templates.
 * 
 * Inside the 24h window: freeform messages work fine (agent conversations)
 * Outside the 24h window: must use Content SID templates
 */

import twilio from "twilio";

// ===== CONTENT SID MAP =====

export const TEMPLATES = {
  // Cobranza
  cierre_mensual: "HX6b6ac64f7367dfd62771569e122c120c",
  recordatorio_pago_dia3: "HX582ee8547070856ea15c3caa17b9ffb0",
  aviso_fg_dia5: "HXd4460ddb10890f3e167bdd7b42ea64d2",
  fg_aplicado: "HX66bad13fe9b72ad73b253185143740fc",
  mora_activa: "HX5bfd79ace1eeb63c42124c049f3885e5",
  recargo_mora: "HXd86a7b60c3aed1793a65fe870e16ed48",
  pago_confirmado_mensual: "HX8bd4e4efd57ef9bdc4810a0f69fcf453",
  ultimo_aviso: "HXffcad800ac6ef065ce98ded5b487c629",
  mora_15_dias: "HX94848a95fec7354f8aab3d364b2990f4",
  mora_30_dias: "HX102c66bf85600796846ed36782e4ac54",
  // Operaciones
  natgas_recaudo_reminder: "HX30f7eca14d0980a1600676ea9b4df267",
  recaudo_procesado: "HX1205b2bbdc23a958f63eae9324c744a7",
  // Director
  reporte_semanal: "HX76daa53bdc44699b7a3dd4dbc520e6e3",
  cierre_resumen_director: "HX852a058d0ef4dfdd33f07b3b664d22d3",
} as const;

// WhatsApp sender number (the one that's ONLINE in Twilio)
const WA_FROM = process.env.TWILIO_WA_NUMBER || "whatsapp:+5214463293102";

function getTwilioClient(): twilio.Twilio | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `whatsapp:+52${digits}`;
  if (digits.length === 12 && digits.startsWith("52")) return `whatsapp:+${digits}`;
  if (digits.length === 13 && digits.startsWith("521")) return `whatsapp:+52${digits.slice(3)}`;
  if (phone.startsWith("whatsapp:")) return phone;
  if (phone.startsWith("+")) return `whatsapp:${phone}`;
  return `whatsapp:+${digits}`;
}

/**
 * Send a template message via Twilio Content API.
 * Variables are passed as contentVariables JSON.
 * 
 * Falls back to freeform if template fails (e.g., not yet approved).
 */
export async function sendTemplate(
  to: string,
  templateKey: keyof typeof TEMPLATES,
  variables: Record<string, string>,
  fallbackText?: string
): Promise<{ success: boolean; method: string; error?: string }> {
  const client = getTwilioClient();
  if (!client) {
    console.warn("[WA Template] No Twilio client — skipping");
    return { success: false, method: "none", error: "No Twilio credentials" };
  }

  const contentSid = TEMPLATES[templateKey];
  const toFormatted = formatPhone(to);

  try {
    // Send using Content SID with variables
    const msg = await client.messages.create({
      from: WA_FROM,
      to: toFormatted,
      contentSid,
      contentVariables: JSON.stringify(variables),
    });
    console.log(`[WA Template] ${templateKey} sent to ${to} — SID: ${msg.sid}`);
    return { success: true, method: "template" };
  } catch (e: any) {
    console.error(`[WA Template] ${templateKey} failed for ${to}: ${e.message}`);
    
    // Fallback: try freeform (works if within 24h window)
    if (fallbackText) {
      try {
        await client.messages.create({
          from: WA_FROM,
          to: toFormatted,
          body: fallbackText,
        });
        console.log(`[WA Template] Fallback freeform sent to ${to}`);
        return { success: true, method: "freeform_fallback" };
      } catch (e2: any) {
        console.error(`[WA Template] Freeform fallback also failed: ${e2.message}`);
        return { success: false, method: "failed", error: e2.message };
      }
    }
    
    return { success: false, method: "failed", error: e.message };
  }
}

/**
 * Send a simple freeform message (only works within 24h window).
 * Use for agent responses within conversations.
 */
export async function sendFreeform(to: string, body: string): Promise<boolean> {
  const client = getTwilioClient();
  if (!client) return false;
  
  try {
    await client.messages.create({
      from: WA_FROM,
      to: formatPhone(to),
      body,
    });
    return true;
  } catch (e: any) {
    console.error(`[WA Freeform] Failed to ${to}: ${e.message}`);
    return false;
  }
}
