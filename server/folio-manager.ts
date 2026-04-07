/**
 * Folio Manager — Create folios and associate documents from WhatsApp
 *
 * Handles:
 * - Creating new origination folios from WhatsApp (promotor/director)
 * - Intelligent document association (matching extracted names to folios)
 */

import type { IStorage } from "./storage";

// ===== Known phones =====
const ANGELES_PHONE = "5214493845228";

/**
 * Create a new folio from WhatsApp.
 *
 * @param storage - DB storage interface
 * @param senderPhone - Phone of the person creating the folio (promotor/director)
 * @param taxistaName - Full name of the taxista (at minimum first name)
 * @param taxistaPhone - Phone number of the taxista
 * @param perfilTipo - Profile type (e.g. "CONCESIONARIO", "OPERADOR")
 * @returns Object with folio string, origination ID, and taxista ID
 */
export async function createFolioFromWhatsApp(
  storage: IStorage,
  senderPhone: string,
  taxistaName: string,
  taxistaPhone: string,
  perfilTipo: string = "CONCESIONARIO",
): Promise<{ folio: string; originationId: number; taxistaId: number }> {
  const now = new Date().toISOString();

  // Parse name parts (best effort: "Juan Pérez López" → nombre, paterno, materno)
  const nameParts = taxistaName.trim().split(/\s+/);
  const nombre = nameParts[0] || taxistaName;
  const apellidoPaterno = nameParts[1] || "";
  const apellidoMaterno = nameParts.slice(2).join(" ") || null;

  // Clean phone (remove whatsapp: prefix, +, spaces)
  const cleanPhone = taxistaPhone.replace(/whatsapp:/gi, "").replace(/[+\s-]/g, "");

  // 1. Create taxista
  const newTaxista = await storage.createTaxista({
    nombre,
    apellidoPaterno,
    apellidoMaterno,
    telefono: cleanPhone,
    perfilTipo,
    ciudad: "Aguascalientes",
    estado: "Aguascalientes",
    createdAt: now,
    curp: null,
    rfc: null,
    email: null,
    direccion: null,
    codigoPostal: null,
    gnvHistorialLeq: null,
    gnvMesesHistorial: null,
    ticketsGasolinaMensual: null,
    clabe: null,
    banco: null,
    folio: null,
  });

  // 2. Generate folio: CMU-SIN-YYMMDD-XXX
  const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const prefix = "CMU-SIN";
  const seq = await storage.getNextFolioSequence(prefix, dateStr);
  const folio = `${prefix}-${dateStr}-${String(seq).padStart(3, "0")}`;

  // 3. Create origination
  const origination = await storage.createOrigination({
    folio,
    tipo: "compraventa",
    estado: "BORRADOR",
    taxistaId: newTaxista.id,
    promoterId: 1, // Ángeles Mireles
    vehicleInventoryId: null,
    perfilTipo,
    currentStep: 1,
    datosIne: null,
    datosCsf: null,
    datosComprobante: null,
    datosConcesion: null,
    datosEstadoCuenta: null,
    datosHistorial: null,
    datosFactura: null,
    datosMembresia: null,
    otpCode: null,
    otpVerified: 0,
    otpPhone: cleanPhone,
    selfieUrl: null,
    vehiclePhotos: null,
    contractType: null,
    contractUrl: null,
    contractGeneratedAt: null,
    mifielDocumentId: null,
    mifielStatus: null,
    notes: `Creado desde WhatsApp por ${senderPhone}`,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
  });

  // 4. Update taxista with folio
  await storage.updateTaxista(newTaxista.id, { folio });

  // 5. Associate phone with folio (via whatsapp_phone_folio, NOT whatsapp_roles)
  // Keep the phone as "unknown" (prospecto) in whatsapp_roles — the state machine handles the flow.
  // Role only changes to "cliente" after director approves evaluation + assigns vehicle.
  try {
    const { neon: neonFn } = await import("@neondatabase/serverless");
    const dbSql = neonFn(process.env.DATABASE_URL!);
    await dbSql`
      INSERT INTO whatsapp_phone_folio (phone, folio, associated_by, created_at)
      VALUES (${cleanPhone}, ${folio}, ${senderPhone}, NOW())
      ON CONFLICT DO NOTHING
    `;
  } catch (e: any) {
    console.warn(`[FolioManager] Could not associate phone-folio for ${cleanPhone}:`, e.message);
  }

  console.log(`[FolioManager] Created folio ${folio} for ${taxistaName} (${cleanPhone}) by ${senderPhone}`);
  return { folio, originationId: origination.id, taxistaId: newTaxista.id };
}

/**
 * Intelligently associate a document to a folio.
 *
 * Priority:
 * 1. If activeFolioId is set (promotor has active folio context), use it
 * 2. If extractedName matches a taxista in DB, use their folio
 * 3. If senderPhone is associated with a folio (client sending own docs), use it
 * 4. Return null if can't determine
 */
export async function associateDocIntelligently(
  storage: IStorage,
  senderPhone: string,
  senderRole: string,
  extractedName: string | null,
  activeFolioId: number | null,
): Promise<{ originationId: number; folio: string; matchType: string } | null> {

  // 1. Active folio context (promotor working on specific folio)
  if (activeFolioId) {
    const orig = await storage.getOrigination(activeFolioId);
    if (orig) {
      return { originationId: orig.id, folio: (orig as any).folio, matchType: "active_folio" };
    }
  }

  // 2. Name match from OCR extraction
  if (extractedName && extractedName.trim().length > 2) {
    const results = await storage.findFolioFlexible(extractedName.trim());
    if (results.length === 1) {
      return {
        originationId: results[0].origination.id,
        folio: (results[0].origination as any).folio,
        matchType: "name_match",
      };
    }
    // Multiple matches — can't auto-determine
    if (results.length > 1) {
      return null;
    }
  }

  // 3. Phone-to-folio association (client sending own docs)
  const clientState = await storage.getClientStateByPhone(senderPhone);
  if (clientState && clientState.found && clientState.originationId) {
    return {
      originationId: clientState.originationId,
      folio: clientState.folio || "?",
      matchType: "phone_match",
    };
  }

  // 4. Can't determine
  return null;
}
