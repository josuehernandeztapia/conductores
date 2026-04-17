/**
 * MESSAGE ROUTER — Single entry point for all inbound WhatsApp messages.
 *
 * Detects role + client status and dispatches to the correct handler:
 *   prospecto → orchestrator.handleProspectMessage (single source of state truth)
 *   cliente   → clientHandler (Airtable-backed)
 *   director  → directorHandler (wraps waAgent)
 *   promotora → promotoraHandler (wraps waAgent)
 *   proveedor → proveedorHandler (Excel)
 *   dev       → directorHandler (same permissions)
 *
 * Critical rules enforced here:
 *   - ONE state system: prospects use context.agentState (orchestrator)
 *   - Timezone: America/Mexico_City for greeting
 *   - Test phones (521999*) filtered upstream in DB queries (unchanged)
 */

import { handleProspectMessage } from "./agent/orchestrator";
import { findClientByPhone } from "./client-menu";
import { clientHandler } from "./handlers/cliente";
import { directorHandler } from "./handlers/director";
import { promotoraHandler } from "./handlers/promotora";
import { proveedorHandler } from "./handlers/proveedor";

export interface RoleInfo {
  role: string;
  name: string;
  permissions: string[];
}

export interface RouterDeps {
  waAgent: any;
  storage: any;
}

export async function routeMessage(
  phone: string,
  body: string,
  profileName: string,
  mediaUrl: string | null,
  mediaType: string | null,
  role: RoleInfo | null,
  deps: RouterDeps,
): Promise<string> {
  const { waAgent, storage } = deps;

  // 1) Compute greeting context (all roles)
  const trimmed = (body || "").trim();
  const isGreeting = /^(?:hola|buenas?|hey|qu[eé]\s*tal|buenos?\s*d[ií]as?|buenas?\s*tardes?|buenas?\s*noches?|ola)\s*[!.?]*$/i.test(trimmed);
  const hour = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }),
  ).getHours();
  const timeGreet = hour < 12 ? "Buenos días" : hour < 18 ? "Buenas tardes" : "Buenas noches";

  const effectiveName = role?.name || profileName || "";

  // 2) No role OR role=prospecto → check client first, else prospecto flow
  if (!role || role.role === "prospecto") {
    try {
      const credit = await findClientByPhone(phone);
      if (credit) {
        return await clientHandler(phone, body, credit, timeGreet, isGreeting);
      }
    } catch (err: any) {
      console.error(`[Router] findClientByPhone failed for ${phone}: ${err.message}`);
    }
    // Prospecto path — orchestrator owns the state
    return await handleProspectMessage(
      phone,
      body,
      mediaUrl,
      mediaType,
      effectiveName,
      storage,
    );
  }

  // 3) Privileged roles
  if (role.role === "director" || role.role === "dev") {
    return await directorHandler(
      phone, body, mediaUrl, mediaType,
      effectiveName, isGreeting, timeGreet,
      { waAgent, storage },
    );
  }

  if (role.role === "promotora") {
    return await promotoraHandler(
      phone, body, mediaUrl, mediaType,
      effectiveName, isGreeting, timeGreet,
      { waAgent, storage },
    );
  }

  if (role.role === "proveedor") {
    return await proveedorHandler(phone, body, mediaUrl, mediaType);
  }

  return "No reconozco tu rol. Escribe *promotor* para ayuda.";
}
