/**
 * Conekta Client — Payment Links for CMU Cobranza
 * 
 * Uses Conekta API v2.2.0 (Payment Link / Checkout)
 * Creates payment links with line items (diferencial + FG)
 * Handles webhook for payment confirmation
 * 
 * API docs: https://developers.conekta.com/reference/payment-link
 */

const CONEKTA_PRIVATE_KEY = () => process.env.CONEKTA_PRIVATE_KEY || process.env.CONEKTA_API_KEY || "";
const CONEKTA_BASE = "https://api.conekta.io";
const CONEKTA_VERSION = "application/vnd.conekta-v2.2.0+json";

// ===== API HELPERS =====

async function conektaFetch(path: string, method: string = "GET", body?: any): Promise<any> {
  const key = CONEKTA_PRIVATE_KEY();
  if (!key) {
    console.warn("[Conekta] No API key configured (set CONEKTA_PRIVATE_KEY)");
    return null;
  }

  const headers: Record<string, string> = {
    "Accept": CONEKTA_VERSION,
    "Content-Type": "application/json",
    "Accept-Language": "es",
    "Authorization": "Basic " + Buffer.from(`${key}:`).toString("base64"),
  };

  const options: RequestInit = { method, headers, signal: AbortSignal.timeout(15000) };
  if (body) options.body = JSON.stringify(body);

  try {
    const res = await fetch(`${CONEKTA_BASE}${path}`, options);
    const data = await res.json();
    if (!res.ok) {
      console.error(`[Conekta] ${method} ${path} ${res.status}:`, JSON.stringify(data).slice(0, 300));
      return { error: true, status: res.status, details: data };
    }
    return data;
  } catch (e: any) {
    console.error(`[Conekta] ${method} ${path} error:`, e.message);
    return { error: true, message: e.message };
  }
}

// ===== PAYMENT LINK CREATION =====

export type PaymentLinkParams = {
  folio: string;
  mes: number;
  taxista: string;
  telefono: string;
  email?: string;
  diferencial: number;    // amount in pesos
  cobroFG: number;        // $334 or $0
  vigenciaDias: number;   // days until link expires
  descripcion?: string;
};

export type PaymentLinkResult = {
  success: boolean;
  checkoutId?: string;
  url?: string;
  expiresAt?: string;
  error?: string;
};

/**
 * Create a Conekta Payment Link (Checkout) for a monthly diferencial + FG.
 * Returns the checkout URL that can be sent via WhatsApp.
 */
export async function crearLigaPago(params: PaymentLinkParams): Promise<PaymentLinkResult> {
  const { folio, mes, taxista, telefono, email, diferencial, cobroFG, vigenciaDias, descripcion } = params;
  const totalCentavos = (diferencial + cobroFG) * 100; // Conekta uses centavos

  // Build line items
  const lineItems: any[] = [];
  if (diferencial > 0) {
    lineItems.push({
      name: `Diferencial cuota mes ${mes}`,
      description: descripcion || `Crédito ${folio} — diferencial mensual`,
      unit_price: diferencial * 100,
      quantity: 1,
    });
  }
  if (cobroFG > 0) {
    lineItems.push({
      name: "Fondo de Garantía",
      description: `Aportación mensual FG — ${folio}`,
      unit_price: cobroFG * 100,
      quantity: 1,
    });
  }

  // Expiration
  const expiresAt = Math.floor(Date.now() / 1000) + (vigenciaDias * 24 * 60 * 60);

  // Create checkout (Payment Link)
  const checkout = await conektaFetch("/checkouts", "POST", {
    name: `${folio} — Mes ${mes}`,
    type: "PaymentLink",
    recurrent: false,
    expires_at: expiresAt,
    allowed_payment_methods: ["card", "cash", "bank_transfer"],
    needs_shipping_contact: false,
    order_template: {
      currency: "MXN",
      customer_info: {
        name: taxista,
        phone: telefono.replace(/\+/g, ""),
        ...(email ? { email } : { email: "contacto@conductores.lat" }),
      },
      line_items: lineItems,
      metadata: {
        folio,
        mes: String(mes),
        tipo: "diferencial_mensual",
      },
    },
  });

  if (checkout?.error) {
    return { success: false, error: checkout.details?.details?.[0]?.message || checkout.message || "Error creating payment link" };
  }

  const checkoutId = checkout?.id;
  const url = checkout?.url;
  const expires = checkout?.expires_at ? new Date(checkout.expires_at * 1000).toISOString().slice(0, 10) : "";

  console.log(`[Conekta] Payment link created: ${checkoutId} | ${url} | expires ${expires} | $${diferencial + cobroFG}`);

  return {
    success: true,
    checkoutId,
    url,
    expiresAt: expires,
  };
}

/**
 * Cancel an existing payment link (when generating a new one with updated amount)
 */
export async function cancelarLiga(checkoutId: string): Promise<boolean> {
  const result = await conektaFetch(`/checkouts/${checkoutId}/cancel`, "PUT");
  return !result?.error;
}

// ===== WEBHOOK HANDLER =====

export type ConektaWebhookEvent = {
  type: string; // "order.paid", "order.expired", etc.
  orderId: string;
  folio: string;
  mes: number;
  monto: number; // in pesos
  metodoPago: string; // "card", "cash", "spei"
  paidAt: string;
};

/**
 * Parse a Conekta webhook event.
 * Returns structured data or null if not a payment event we care about.
 */
export function parseConektaWebhook(body: any): ConektaWebhookEvent | null {
  try {
    const eventType = body?.type;
    if (!eventType) return null;

    const order = body?.data?.object;
    if (!order) return null;

    const orderId = order.id || "";
    const metadata = order.metadata || {};
    const folio = metadata.folio || "";
    const mes = parseInt(metadata.mes || "0");
    const monto = (order.amount || 0) / 100; // centavos to pesos

    // Determine payment method
    let metodoPago = "desconocido";
    const charges = order.charges?.data || [];
    if (charges.length > 0) {
      const pm = charges[0]?.payment_method;
      if (pm?.type === "card" || pm?.type === "credit") metodoPago = "Conekta Tarjeta";
      else if (pm?.type === "cash") metodoPago = "Conekta Efectivo";
      else if (pm?.type === "spei" || pm?.type === "bank_transfer") metodoPago = "Conekta SPEI";
      else metodoPago = `Conekta ${pm?.type || "?"}`;
    }

    const paidAt = charges[0]?.paid_at
      ? new Date(charges[0].paid_at * 1000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    return { type: eventType, orderId, folio, mes, monto, metodoPago, paidAt };
  } catch (e: any) {
    console.error("[Conekta] Webhook parse error:", e.message);
    return null;
  }
}

/**
 * Check if Conekta is configured
 */
export function isConektaEnabled(): boolean {
  return !!CONEKTA_PRIVATE_KEY();
}
