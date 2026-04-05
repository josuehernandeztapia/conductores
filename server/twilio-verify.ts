/**
 * Twilio Verify — OTP via WhatsApp/SMS for prospect registration
 * 
 * Service: CMU Verificacion
 * SID: VAb7b31cdc560d238ed2bd90da259b9a12
 * Channels: WhatsApp (primary) → SMS (fallback)
 */

import twilio from "twilio";

const VERIFY_SERVICE_SID = "VAb7b31cdc560d238ed2bd90da259b9a12";

function getTwilioClient(): twilio.Twilio | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    console.warn("[Verify] No Twilio credentials — OTP disabled");
    return null;
  }
  return twilio(sid, token);
}

/**
 * Normalize phone to E.164 format for Mexico
 * Input: "4491234567", "524491234567", "+524491234567", "5214491234567"
 * Output: "+524491234567"
 */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+52${digits}`;
  if (digits.length === 12 && digits.startsWith("52")) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith("521")) return `+52${digits.slice(3)}`;
  if (phone.startsWith("+")) return phone;
  return `+${digits}`;
}

/**
 * Send OTP code via WhatsApp (falls back to SMS automatically)
 */
export async function sendOTP(phone: string): Promise<{ success: boolean; channel: string; error?: string }> {
  const client = getTwilioClient();
  if (!client) {
    return { success: false, channel: "none", error: "Twilio no configurado" };
  }

  const to = normalizePhone(phone);
  
  try {
    // Try WhatsApp first
    const verification = await client.verify.v2
      .services(VERIFY_SERVICE_SID)
      .verifications.create({
        channel: "whatsapp",
        to,
      });
    
    console.log(`[Verify] OTP sent to ${to} via ${verification.channel} — status: ${verification.status}`);
    return { success: true, channel: verification.channel };
  } catch (e: any) {
    // If WhatsApp fails, try SMS
    console.warn(`[Verify] WhatsApp failed for ${to}: ${e.message}. Trying SMS...`);
    try {
      const verification = await client.verify.v2
        .services(VERIFY_SERVICE_SID)
        .verifications.create({
          channel: "sms",
          to,
        });
      
      console.log(`[Verify] OTP sent to ${to} via SMS — status: ${verification.status}`);
      return { success: true, channel: "sms" };
    } catch (e2: any) {
      console.error(`[Verify] SMS also failed for ${to}: ${e2.message}`);
      return { success: false, channel: "none", error: e2.message };
    }
  }
}

/**
 * Verify OTP code entered by the user
 */
export async function checkOTP(phone: string, code: string): Promise<{ valid: boolean; status: string; error?: string }> {
  const client = getTwilioClient();
  if (!client) {
    return { valid: false, status: "error", error: "Twilio no configurado" };
  }

  const to = normalizePhone(phone);

  try {
    const check = await client.verify.v2
      .services(VERIFY_SERVICE_SID)
      .verificationChecks.create({
        code,
        to,
      });
    
    console.log(`[Verify] OTP check for ${to}: ${check.status}`);
    return { valid: check.status === "approved", status: check.status };
  } catch (e: any) {
    console.error(`[Verify] OTP check error for ${to}: ${e.message}`);
    return { valid: false, status: "error", error: e.message };
  }
}

/**
 * Check if Twilio Verify is configured
 */
export function isVerifyEnabled(): boolean {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}
