/**
 * CMU WhatsApp Agent v3 — Notifications
 *
 * Sends WhatsApp notifications to team members.
 * Uses the internal outbound API at localhost:5000/api/whatsapp/send-outbound.
 * Josué (Director): 5214422022540
 */

import { DIRECTOR, getNotifyPhones, getPromotor } from "../team-config";

const OUTBOUND_URL = "http://localhost:5000/api/whatsapp/send-outbound";

// ─── Core Send ───────────────────────────────────────────────────────────────

async function sendWhatsApp(phone: string, message: string): Promise<boolean> {
  try {
    const response = await fetch(OUTBOUND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: `whatsapp:+${phone}`, body: message }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[Notifications] Send failed to ${phone}: ${response.status} — ${text}`);
      return false;
    }

    console.log(`[Notifications] Sent to ${phone}: ${message.slice(0, 50)}...`);
    return true;
  } catch (error: any) {
    console.error(`[Notifications] Send error to ${phone}:`, error.message);
    return false;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Send a notification to ALL team members (director + active promotores).
 */
export async function notifyTeam(msg: string): Promise<void> {
  const phones = getNotifyPhones();
  const results = await Promise.allSettled(
    phones.map(phone => sendWhatsApp(phone, msg))
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      console.error(`[Notifications] notifyTeam failed for ${phones[i]}:`, result.reason);
    }
  }
}

/**
 * Send a notification only to the director (Josué).
 */
export async function notifyDirector(msg: string): Promise<void> {
  await sendWhatsApp(DIRECTOR.phone, msg);
}

/**
 * Send a notification to a specific promotor.
 */
export async function notifyPromotor(promotorId: string, msg: string): Promise<void> {
  const promotor = getPromotor(promotorId);
  if (promotor) {
    await sendWhatsApp(promotor.phone, msg);
  } else {
    console.error(`[Notifications] Promotor not found: ${promotorId}`);
  }
}
