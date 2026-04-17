/**
 * PROMOTORA HANDLER
 *
 * Thin wrapper around WhatsAppAgent.handleMessage for role=promotora.
 * The underlying agent handles: eval parser FIRST, menu 1-4, RAG for FAQ,
 * doc capture for prospects, PIN re-auth after 15 min inactivity.
 */

export interface PromotoraDeps {
  waAgent: any;
  storage: any;
}

export async function promotoraHandler(
  phone: string,
  body: string,
  mediaUrl: string | null,
  mediaType: string | null,
  roleName: string,
  _isGreeting: boolean,
  _timeGreet: string,
  deps: PromotoraDeps,
): Promise<string> {
  const { waAgent } = deps;
  if (!waAgent) {
    return "⚠️ Agente no disponible. Revisa la configuración de OpenAI.";
  }

  const result = await waAgent.handleMessage(
    phone,
    body,
    roleName,
    mediaUrl,
    mediaType,
    null,
    "promotora",
    roleName,
    ["promotora"],
  );

  return result?.reply || "";
}
