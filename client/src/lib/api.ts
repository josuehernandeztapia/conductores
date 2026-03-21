/**
 * API client for CMU Decision Engine.
 * Tries backend API first, falls back to in-memory storage if unavailable.
 * This allows the app to work both as static deploy (no backend) and on Fly.io (with Neon).
 */

import * as storage from "./storage";

// Auth token (in-memory only, no localStorage)
let authToken: string | null = null;
let currentPromoter: { id: number; name: string } | null = null;

// API base URL: uses __PORT_5000__ which deploy_website rewrites to the proxy path.
// Locally (dev), __PORT_5000__ starts with "__" so we use empty string (relative).
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Track whether backend is available — retries every 30 seconds after failure
let backendAvailable: boolean | null = null; // null = unknown
let lastBackendCheck = 0;
const BACKEND_RETRY_MS = 30000; // retry after 30s

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {}),
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  return res;
}

async function tryApi<T>(apiCall: () => Promise<T>, fallback: () => T): Promise<T> {
  // If we know backend is unavailable, skip to fallback — but retry after BACKEND_RETRY_MS
  if (backendAvailable === false) {
    const now = Date.now();
    if (now - lastBackendCheck < BACKEND_RETRY_MS) {
      return fallback();
    }
    // Enough time has passed, try the backend again
    backendAvailable = null;
  }

  try {
    const result = await apiCall();
    backendAvailable = true;
    lastBackendCheck = Date.now();
    return result;
  } catch (err) {
    console.warn("[API] Backend unavailable, using in-memory fallback:", (err as Error).message);
    backendAvailable = false;
    lastBackendCheck = Date.now();
    return fallback();
  }
}

// ============================================================
// AUTH
// ============================================================

export async function apiLogin(pin: string): Promise<{ id: number; name: string } | null> {
  return tryApi(
    async () => {
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ pin }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      authToken = data.token;
      currentPromoter = data.promoter;
      return data.promoter;
    },
    () => {
      const promoter = storage.getPromoterByPin(pin);
      if (!promoter) return null;
      currentPromoter = { id: promoter.id, name: promoter.name };
      return currentPromoter;
    }
  );
}

export function getAuthPromoter() {
  return currentPromoter;
}

export function logout() {
  authToken = null;
  currentPromoter = null;
}

// ============================================================
// ORIGINATIONS
// ============================================================

export async function apiListOriginations() {
  return tryApi(
    async () => {
      const res = await apiFetch("/api/originations");
      if (!res.ok) throw new Error("Failed to fetch originations");
      const data = await res.json();
      // Normalize snake_case → camelCase for frontend compat
      return data.map(normalizeOrigination);
    },
    () => storage.listOriginations()
  );
}

export async function apiGetOrigination(id: number) {
  return tryApi(
    async () => {
      const res = await apiFetch(`/api/originations/${id}`);
      if (!res.ok) throw new Error("Failed to fetch origination");
      const data = await res.json();
      return normalizeOrigination(data);
    },
    () => storage.getOrigination(id) || null
  );
}

export async function apiCreateOrigination(data: {
  folio: string;
  tipo: string;
  perfilTipo: string;
  taxistaId?: number | null;
  promoterId?: number;
  otpPhone?: string;
}) {
  return tryApi(
    async () => {
      const res = await apiFetch("/api/originations", {
        method: "POST",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create origination");
      const result = await res.json();
      return normalizeOrigination(result);
    },
    () => {
      const now = new Date().toISOString();
      return storage.createOrigination({
        folio: data.folio,
        tipo: data.tipo,
        estado: "BORRADOR",
        taxistaId: data.taxistaId || null,
        promoterId: data.promoterId || 1,
        vehicleInventoryId: null,
        perfilTipo: data.perfilTipo,
        currentStep: 1,
        datosIne: null, datosCsf: null, datosComprobante: null,
        datosConcesion: null, datosEstadoCuenta: null, datosHistorial: null,
        datosFactura: null, datosMembresia: null,
        otpCode: null, otpVerified: 0, otpPhone: data.otpPhone || null,
        selfieUrl: null, vehiclePhotos: null,
        contractType: null, contractUrl: null, contractGeneratedAt: null,
        mifielDocumentId: null, mifielStatus: null,
        notes: null, rejectionReason: null,
        createdAt: now, updatedAt: now,
      });
    }
  );
}

export async function apiUpdateOrigination(id: number, data: Record<string, any>) {
  return tryApi(
    async () => {
      const res = await apiFetch(`/api/originations/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update origination");
      const result = await res.json();
      return normalizeOrigination(result);
    },
    () => storage.updateOrigination(id, data) || null
  );
}

// ============================================================
// DOCUMENTS
// ============================================================

export async function apiGetDocuments(originationId: number) {
  return tryApi(
    async () => {
      const res = await apiFetch(`/api/documents/${originationId}`);
      if (!res.ok) throw new Error("Failed to fetch documents");
      const data = await res.json();
      return data.map(normalizeDocument);
    },
    () => storage.getDocumentsByOrigination(originationId)
  );
}

export async function apiSaveDocument(data: {
  originationId: number;
  tipo: string;
  imageData: string;
  ocrResult?: string;
  ocrConfidence?: string;
  editedData?: string;
  status?: string;
}) {
  return tryApi(
    async () => {
      const res = await apiFetch("/api/documents", {
        method: "POST",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save document");
      const result = await res.json();
      return normalizeDocument(result);
    },
    () => {
      const existing = storage.getDocumentByOriginationAndType(data.originationId, data.tipo);
      if (existing) {
        return storage.updateDocument(existing.id, {
          imageData: data.imageData,
          ocrResult: data.ocrResult || null,
          ocrConfidence: data.ocrConfidence || "media",
          editedData: data.editedData || null,
          status: data.status || "captured",
        })!;
      }
      return storage.createDocument({
        originationId: data.originationId,
        tipo: data.tipo,
        imageData: data.imageData,
        ocrResult: data.ocrResult || null,
        ocrConfidence: data.ocrConfidence || "media",
        editedData: data.editedData || null,
        status: data.status || "captured",
        createdAt: new Date().toISOString(),
      });
    }
  );
}

// ============================================================
// OCR — Claude Vision
// ============================================================

export async function apiRunOcr(data: {
  originationId: number;
  docType: string;
  imageData: string;
}): Promise<{ extractedData: Record<string, any>; confidence: "alta" | "media" | "baja"; documentId?: number }> {
  try {
    const res = await apiFetch("/api/originations/ocr", {
      method: "POST",
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ message: "Error en OCR" }));
      throw new Error(errBody.message || "Error en OCR");
    }
    return await res.json();
  } catch (err: any) {
    console.warn("[OCR] Backend OCR failed, returning simulated result:", err.message);
    // Fallback: save doc locally with simulated OCR and return empty data
    const simulated: Record<string, any> = {};
    await apiSaveDocument({
      originationId: data.originationId,
      tipo: data.docType,
      imageData: data.imageData,
      ocrResult: JSON.stringify(simulated),
      ocrConfidence: "baja",
      editedData: JSON.stringify(simulated),
      status: "ocr_done",
    });
    return { extractedData: simulated, confidence: "baja" };
  }
}

// ============================================================
// VEHICLES
// ============================================================

export async function apiListVehicles() {
  return tryApi(
    async () => {
      const res = await apiFetch("/api/vehicles");
      if (!res.ok) throw new Error("Failed to fetch vehicles");
      const data = await res.json();
      return data.map(normalizeVehicle);
    },
    () => storage.listVehicles()
  );
}

export async function apiCreateVehicle(data: Record<string, any>) {
  return tryApi(
    async () => {
      const res = await apiFetch("/api/vehicles", {
        method: "POST",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create vehicle");
      const result = await res.json();
      return normalizeVehicle(result);
    },
    () => {
      const now = new Date().toISOString();
      return storage.createVehicle({ ...data, createdAt: now, updatedAt: now } as any);
    }
  );
}

// ============================================================
// EVALUATIONS
// ============================================================

export async function apiSaveEvaluation(data: Record<string, any>) {
  return tryApi(
    async () => {
      const res = await apiFetch("/api/evaluations", {
        method: "POST",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save evaluation");
      return await res.json();
    },
    () => storage.saveOpportunity(data as any)
  );
}

export async function apiListEvaluations() {
  return tryApi(
    async () => {
      const res = await apiFetch("/api/evaluations");
      if (!res.ok) throw new Error("Failed to fetch evaluations");
      return await res.json();
    },
    () => storage.getOpportunities()
  );
}

// ============================================================
// STATS
// ============================================================

export async function apiGetStats() {
  return tryApi(
    async () => {
      const res = await apiFetch("/api/stats");
      if (!res.ok) throw new Error("Failed to fetch stats");
      return await res.json();
    },
    () => {
      const vehicles = storage.listVehicles();
      const originations = storage.listOriginations();
      const vByStatus: Record<string, number> = {};
      vehicles.forEach((v) => { vByStatus[v.status] = (vByStatus[v.status] || 0) + 1; });
      const oByEstado: Record<string, number> = {};
      originations.forEach((o) => { oByEstado[o.estado] = (oByEstado[o.estado] || 0) + 1; });
      return {
        vehiclesByStatus: Object.entries(vByStatus).map(([status, count]) => ({ status, count })),
        originationsByEstado: Object.entries(oByEstado).map(([estado, count]) => ({ estado, count })),
        totalVehicles: vehicles.length,
        totalOriginations: originations.length,
      };
    }
  );
}

// ============================================================
// MODELS (always from storage — seed data)
// ============================================================

export function apiGetModels() {
  return storage.getModels();
}

export function apiGetModelOptions() {
  return storage.getModelOptions();
}

export function apiGetModelById(id: number) {
  return storage.getModelById(id);
}

// ============================================================
// STORAGE PROXY (for components that still need subscribe)
// ============================================================

export { subscribe, initStore } from "./storage";

// Re-export folio sequence from storage (always local)
export { getNextFolioSequence } from "./storage";

// Re-export taxista ops from storage (local for now)
export { createTaxista, getTaxista } from "./storage";

// ============================================================
// NORMALIZATION HELPERS
// ============================================================

function normalizeVehicle(row: any) {
  if (!row) return row;
  return {
    id: row.id,
    marca: row.marca,
    modelo: row.modelo,
    variante: row.variante ?? null,
    anio: row.anio,
    color: row.color ?? null,
    niv: row.niv ?? null,
    placas: row.placas ?? null,
    numSerie: row.num_serie ?? row.numSerie ?? null,
    numMotor: row.num_motor ?? row.numMotor ?? null,
    cmuValor: row.cmu_valor ?? row.cmuValor ?? null,
    costoAdquisicion: row.costo_adquisicion ?? row.costoAdquisicion ?? null,
    costoReparacion: row.costo_reparacion ?? row.costoReparacion ?? null,
    status: row.status ?? "disponible",
    assignedOriginationId: row.assigned_origination_id ?? row.assignedOriginationId ?? null,
    assignedTaxistaId: row.assigned_taxista_id ?? row.assignedTaxistaId ?? null,
    kitGnvInstalado: row.kit_gnv_instalado ?? row.kitGnvInstalado ?? 0,
    kitGnvCosto: row.kit_gnv_costo ?? row.kitGnvCosto ?? null,
    kitGnvMarca: row.kit_gnv_marca ?? row.kitGnvMarca ?? null,
    kitGnvSerie: row.kit_gnv_serie ?? row.kitGnvSerie ?? null,
    tanqueTipo: row.tanque_tipo ?? row.tanqueTipo ?? null,
    tanqueMarca: row.tanque_marca ?? row.tanqueMarca ?? null,
    tanqueSerie: row.tanque_serie ?? row.tanqueSerie ?? null,
    tanqueCosto: row.tanque_costo ?? row.tanqueCosto ?? null,
    fotos: row.fotos ?? null,
    notes: row.notes ?? null,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

function normalizeOrigination(row: any) {
  if (!row) return row;
  return {
    id: row.id,
    folio: row.folio,
    tipo: row.tipo,
    estado: row.estado,
    taxistaId: row.taxista_id ?? row.taxistaId ?? null,
    promoterId: row.promoter_id ?? row.promoterId ?? 1,
    vehicleInventoryId: row.vehicle_inventory_id ?? row.vehicleInventoryId ?? null,
    perfilTipo: row.perfil_tipo ?? row.perfilTipo,
    currentStep: row.current_step ?? row.currentStep ?? 1,
    datosIne: row.datos_ine ?? row.datosIne ?? null,
    datosCsf: row.datos_csf ?? row.datosCsf ?? null,
    datosComprobante: row.datos_comprobante ?? row.datosComprobante ?? null,
    datosConcesion: row.datos_concesion ?? row.datosConcesion ?? null,
    datosEstadoCuenta: row.datos_estado_cuenta ?? row.datosEstadoCuenta ?? null,
    datosHistorial: row.datos_historial ?? row.datosHistorial ?? null,
    datosFactura: row.datos_factura ?? row.datosFactura ?? null,
    datosMembresia: row.datos_membresia ?? row.datosMembresia ?? null,
    otpCode: row.otp_code ?? row.otpCode ?? null,
    otpVerified: row.otp_verified ?? row.otpVerified ?? 0,
    otpPhone: row.otp_phone ?? row.otpPhone ?? null,
    selfieUrl: row.selfie_url ?? row.selfieUrl ?? null,
    vehiclePhotos: row.vehicle_photos ?? row.vehiclePhotos ?? null,
    contractType: row.contract_type ?? row.contractType ?? null,
    contractUrl: row.contract_url ?? row.contractUrl ?? null,
    contractGeneratedAt: row.contract_generated_at ?? row.contractGeneratedAt ?? null,
    mifielDocumentId: row.mifiel_document_id ?? row.mifielDocumentId ?? null,
    mifielStatus: row.mifiel_status ?? row.mifielStatus ?? null,
    notes: row.notes ?? null,
    rejectionReason: row.rejection_reason ?? row.rejectionReason ?? null,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

function normalizeDocument(row: any) {
  if (!row) return row;
  return {
    id: row.id,
    originationId: row.origination_id ?? row.originationId,
    tipo: row.tipo,
    imageData: row.image_data ?? row.imageData ?? null,
    ocrResult: row.ocr_result ?? row.ocrResult ?? null,
    ocrConfidence: row.ocr_confidence ?? row.ocrConfidence ?? null,
    editedData: row.edited_data ?? row.editedData ?? null,
    status: row.status ?? "pending",
    createdAt: row.created_at ?? row.createdAt,
  };
}

// ============================================================
// OTP — Twilio Verify Integration
// ============================================================

export async function apiSendOtp(phone: string, originationId: number): Promise<{ success: boolean; simulated?: boolean; status?: string; note?: string }> {
  try {
    const res = await apiFetch(`/api/originations/${originationId}/otp/send`, {
      method: "POST",
      body: JSON.stringify({ phone }),
    });
    if (!res.ok) throw new Error("Failed to send OTP");
    const data = await res.json();
    return { success: data.success ?? true, simulated: true, status: "pending" };
  } catch (err: any) {
    console.error("OTP send error:", err);
    // Return simulated success so the UX still works
    return { success: true, simulated: true, status: "pending" };
  }
}

export async function apiVerifyOtp(phone: string, code: string, originationId: number): Promise<{ success: boolean; verified: boolean; simulated?: boolean; message?: string }> {
  try {
    const res = await apiFetch(`/api/originations/${originationId}/otp/verify`, {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error("Failed to verify OTP");
    const data = await res.json();
    return { success: true, verified: data.verified === true, simulated: true };
  } catch (err: any) {
    console.error("OTP verify error:", err);
    return { success: false, verified: false, message: err.message };
  }
}

// ============================================================
// BACKEND STATUS
// ============================================================

export function isBackendAvailable() {
  return backendAvailable === true;
}

export async function checkBackendHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      backendAvailable = true;
      return true;
    }
  } catch (_) {}
  backendAvailable = false;
  return false;
}
