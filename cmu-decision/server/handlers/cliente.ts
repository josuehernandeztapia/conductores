/**
 * CLIENTE HANDLER — For taxistas with active credits (Airtable-based)
 *
 * Wraps server/client-menu.ts. Detects menu option (1-4) or natural-language
 * intent ("cuánto debo", "estado", "pagar") and replies with the right view.
 * On greeting, returns the credit summary + menu.
 */

import {
  findClientByPhone,
  clientGreeting,
  clientEstadoCuenta,
  clientHacerPago,
  clientRecaudoGNV,
} from "../client-menu";

const PROMOTOR_PHONE = process.env.PROMOTOR_PHONE || "+52 55 1234 5678";

type ClientCredit = NonNullable<Awaited<ReturnType<typeof findClientByPhone>>>;

export async function clientHandler(
  _phone: string,
  body: string,
  credit: ClientCredit,
  timeGreet: string,
  isGreeting: boolean,
): Promise<string> {
  const text = (body || "").trim().toLowerCase();

  // Greeting or empty → show menu
  if (isGreeting || !text) {
    return clientGreeting(credit, timeGreet);
  }

  // Menu options — numeric or natural language
  if (/^1\b/.test(text) || /estado/.test(text) || /cuenta/.test(text) || /\bdebo\b|cu[aá]nto\s+debo/.test(text)) {
    return clientEstadoCuenta(credit);
  }
  if (/^2\b/.test(text) || /\bpagar\b|pago/.test(text)) {
    return clientHacerPago(credit);
  }
  if (/^3\b/.test(text) || /recaudo|gnv/.test(text)) {
    return clientRecaudoGNV(credit);
  }
  if (/^4\b/.test(text) || /promotor|humano|asesor/.test(text)) {
    return `Te pongo en contacto con un promotor.\n\n📞 ${PROMOTOR_PHONE}\n\nO escribe tu pregunta y te ayudamos.`;
  }

  // Fallback: show menu
  return clientGreeting(credit, timeGreet);
}
