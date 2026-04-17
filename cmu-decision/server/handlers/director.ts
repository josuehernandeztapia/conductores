/**
 * DIRECTOR HANDLER
 *
 * Thin wrapper around the existing WhatsAppAgent.handleMessage for role=director.
 * Preserves the full behavior of the monolith (eval parser → RAG → menu →
 * commands → LLM fallback) while presenting a single-entry contract that the
 * message-router can call.
 *
 * The underlying waAgent already implements:
 *   - Eval parser (parseEvalLine) FIRST priority for director
 *   - RAG before LLM
 *   - Menu 1-4 (dudas, nuevo prospecto, evaluar, inventario)
 *   - Commands: números, cartera, folios, mercado, cierre, auditar
 *   - Canal C (LLM) as last resort
 */

export interface DirectorDeps {
  waAgent: any;
  storage: any;
}

export async function directorHandler(
  phone: string,
  body: string,
  mediaUrl: string | null,
  mediaType: string | null,
  roleName: string,
  _isGreeting: boolean,
  _timeGreet: string,
  deps: DirectorDeps,
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
    null, // originationId resolved by the agent itself via convState
    "director",
    roleName,
    ["director"],
  );

  return result?.reply || "";
}
