/**
 * fly-server.js — Servidor Express para Fly.io + Neon PostgreSQL
 * CRUD real para originaciones, documentos, vehículos, evaluaciones.
 * Placeholders para Mifiel, Twilio, Conekta.
 *
 * Usage: node fly-server.js
 * Env: DATABASE_URL, PORT (default 3000)
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(express.json({ limit: "15mb" })); // large for base64 images

// --- Database ---
const DATABASE_URL = process.env.DATABASE_URL;
let sql = null;

if (DATABASE_URL) {
  sql = neon(DATABASE_URL);
  console.log("[DB] Connected to Neon PostgreSQL");
} else {
  console.warn("[DB] DATABASE_URL not set — using in-memory fallback");
}

// Simple in-memory fallback when no DB
const mem = {
  promoters: [{ id: 1, name: "Ángeles Mireles", pin: "123456", phone: "+524491234567", active: 1, created_at: new Date().toISOString() }],
  originations: [],
  documents: [],
  vehicles: [
    { id: 1, marca: "Nissan", modelo: "March", variante: "Sense", anio: 2022, color: "Blanco", niv: "3N1CK3CD5NL000001", placas: "AGS-1234", num_serie: "NL000001", num_motor: "HR12DE-001234", cmu_valor: 200000, costo_adquisicion: 120000, costo_reparacion: 15000, status: "disponible", assigned_origination_id: null, assigned_taxista_id: null, kit_gnv_instalado: 1, kit_gnv_costo: 18000, kit_gnv_marca: "LOVATO", kit_gnv_serie: "LVT-2024-0001", tanque_tipo: "nuevo", tanque_marca: "CILBRAS", tanque_serie: "CIL-60L-0001", tanque_costo: 12000, fotos: null, notes: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: 2, marca: "Chevrolet", modelo: "Aveo", variante: null, anio: 2023, color: "Gris", niv: "3G1TC5CF3PL000002", placas: "AGS-5678", num_serie: "PL000002", num_motor: "B12D1-005678", cmu_valor: 205000, costo_adquisicion: 108000, costo_reparacion: 10000, status: "disponible", assigned_origination_id: null, assigned_taxista_id: null, kit_gnv_instalado: 0, kit_gnv_costo: null, kit_gnv_marca: null, kit_gnv_serie: null, tanque_tipo: null, tanque_marca: null, tanque_serie: null, tanque_costo: null, fotos: null, notes: "Pendiente instalación kit GNV", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: 3, marca: "Nissan", modelo: "V-Drive", variante: null, anio: 2022, color: "Rojo", niv: "3N1CK3CD7NL000003", placas: "AGS-9012", num_serie: "NL000003", num_motor: "HR16DE-009012", cmu_valor: 221000, costo_adquisicion: 132000, costo_reparacion: 8000, status: "en_reparacion", assigned_origination_id: null, assigned_taxista_id: null, kit_gnv_instalado: 1, kit_gnv_costo: 18000, kit_gnv_marca: "TOMASETTO", kit_gnv_serie: "TMS-2024-0003", tanque_tipo: "reusado", tanque_marca: "CILBRAS", tanque_serie: "CIL-60L-R003", tanque_costo: 8000, fotos: null, notes: "En taller, estimado 1 semana", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: 4, marca: "Nissan", modelo: "March", variante: "Advance", anio: 2021, color: "Azul", niv: "3N1CK3CD1ML000004", placas: "AGS-3456", num_serie: "ML000004", num_motor: "HR12DE-003456", cmu_valor: 224000, costo_adquisicion: 134000, costo_reparacion: 12000, status: "asignado", assigned_origination_id: null, assigned_taxista_id: null, kit_gnv_instalado: 1, kit_gnv_costo: 18000, kit_gnv_marca: "LOVATO", kit_gnv_serie: "LVT-2024-0004", tanque_tipo: "nuevo", tanque_marca: "WORTHINGTON", tanque_serie: "WTH-60L-0004", tanque_costo: 12000, fotos: null, notes: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ],
  evaluations: [],
  _nextId: { originations: 1, documents: 1, vehicles: 5, evaluations: 1 },
};

// Helper: run query or use memory
async function dbQuery(queryFn, memFallbackFn) {
  if (sql) {
    try {
      return await queryFn(sql);
    } catch (err) {
      console.error("[DB Error]", err.message);
      throw err;
    }
  }
  return memFallbackFn();
}

// ============================================================
// AUTH
// ============================================================

app.post("/api/auth/login", async (req, res) => {
  const { pin } = req.body || {};
  if (!pin) return res.status(400).json({ error: "PIN requerido" });

  try {
    const result = await dbQuery(
      async (sql) => {
        const rows = await sql`SELECT * FROM promoters WHERE pin = ${pin} AND active = 1 LIMIT 1`;
        return rows[0] || null;
      },
      () => mem.promoters.find((p) => p.pin === pin && p.active === 1) || null
    );

    if (!result) return res.status(401).json({ error: "PIN incorrecto" });

    // Simple token (no JWT needed for internal app)
    const token = Buffer.from(`${result.id}:${Date.now()}`).toString("base64");
    res.json({ success: true, token, promoter: { id: result.id, name: result.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ORIGINATIONS
// ============================================================

app.get("/api/originations", async (req, res) => {
  try {
    const result = await dbQuery(
      async (sql) => await sql`SELECT * FROM originations ORDER BY created_at DESC`,
      () => [...mem.originations].sort((a, b) => b.created_at.localeCompare(a.created_at))
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/originations", async (req, res) => {
  const data = req.body;
  const now = new Date().toISOString();
  try {
    const result = await dbQuery(
      async (sql) => {
        const rows = await sql`
          INSERT INTO originations (folio, tipo, estado, taxista_id, promoter_id, vehicle_inventory_id, perfil_tipo, current_step, otp_verified, otp_phone, created_at, updated_at)
          VALUES (${data.folio}, ${data.tipo}, ${data.estado || "BORRADOR"}, ${data.taxistaId || null}, ${data.promoterId || 1}, ${data.vehicleInventoryId || null}, ${data.perfilTipo}, ${data.currentStep || 1}, 0, ${data.otpPhone || null}, ${now}, ${now})
          RETURNING *`;
        return rows[0];
      },
      () => {
        const id = mem._nextId.originations++;
        const orig = {
          id, folio: data.folio, tipo: data.tipo, estado: data.estado || "BORRADOR",
          taxista_id: data.taxistaId || null, promoter_id: data.promoterId || 1,
          vehicle_inventory_id: data.vehicleInventoryId || null, perfil_tipo: data.perfilTipo,
          current_step: data.currentStep || 1, otp_code: null, otp_verified: 0, otp_phone: data.otpPhone || null,
          selfie_url: null, vehicle_photos: null, contract_type: null, contract_url: null,
          contract_generated_at: null, mifiel_document_id: null, mifiel_status: null,
          notes: null, rejection_reason: null, datos_ine: null, datos_csf: null,
          datos_comprobante: null, datos_concesion: null, datos_estado_cuenta: null,
          datos_historial: null, datos_factura: null, datos_membresia: null,
          created_at: now, updated_at: now,
          // camelCase aliases for frontend compat
          taxistaId: data.taxistaId || null, promoterId: data.promoterId || 1,
          vehicleInventoryId: data.vehicleInventoryId || null, perfilTipo: data.perfilTipo,
          currentStep: data.currentStep || 1, otpCode: null, otpVerified: 0, otpPhone: data.otpPhone || null,
          selfieUrl: null, vehiclePhotos: null, contractType: null, contractUrl: null,
          contractGeneratedAt: null, mifielDocumentId: null, mifielStatus: null,
          rejectionReason: null, datosIne: null, datosCsf: null,
          datosComprobante: null, datosConcesion: null, datosEstadoCuenta: null,
          datosHistorial: null, datosFactura: null, datosMembresia: null,
          createdAt: now, updatedAt: now,
        };
        mem.originations.push(orig);
        return orig;
      }
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/originations/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const result = await dbQuery(
      async (sql) => {
        const rows = await sql`SELECT * FROM originations WHERE id = ${id}`;
        return rows[0] || null;
      },
      () => mem.originations.find((o) => o.id === id) || null
    );
    if (!result) return res.status(404).json({ error: "Folio no encontrado" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/originations/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const data = req.body;
  const now = new Date().toISOString();
  try {
    const result = await dbQuery(
      async (sql) => {
        // Update all provided fields using COALESCE (null = keep existing)
        const rows = await sql`
          UPDATE originations SET
            current_step = COALESCE(${data.currentStep ?? null}, current_step),
            estado = COALESCE(${data.estado ?? null}, estado),
            taxista_id = COALESCE(${data.taxistaId ?? null}, taxista_id),
            vehicle_inventory_id = COALESCE(${data.vehicleInventoryId ?? null}, vehicle_inventory_id),
            otp_code = COALESCE(${data.otpCode ?? null}, otp_code),
            otp_verified = COALESCE(${data.otpVerified ?? null}, otp_verified),
            otp_phone = COALESCE(${data.otpPhone ?? null}, otp_phone),
            selfie_url = COALESCE(${data.selfieUrl ?? null}, selfie_url),
            contract_type = COALESCE(${data.contractType ?? null}, contract_type),
            contract_url = COALESCE(${data.contractUrl ?? null}, contract_url),
            contract_generated_at = COALESCE(${data.contractGeneratedAt ?? null}, contract_generated_at),
            mifiel_document_id = COALESCE(${data.mifielDocumentId ?? null}, mifiel_document_id),
            mifiel_status = COALESCE(${data.mifielStatus ?? null}, mifiel_status),
            notes = COALESCE(${data.notes ?? null}, notes),
            rejection_reason = COALESCE(${data.rejectionReason ?? null}, rejection_reason),
            updated_at = ${now}
          WHERE id = ${id}
          RETURNING *`;
        return rows[0];
      },
      () => {
        const orig = mem.originations.find((o) => o.id === id);
        if (!orig) return null;
        Object.assign(orig, data, { updated_at: now, updatedAt: now });
        return orig;
      }
    );
    if (!result) return res.status(404).json({ error: "Folio no encontrado" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// DOCUMENTS
// ============================================================

app.get("/api/documents/:originationId", async (req, res) => {
  const originationId = parseInt(req.params.originationId);
  try {
    const result = await dbQuery(
      async (sql) => await sql`SELECT * FROM documents WHERE origination_id = ${originationId} ORDER BY created_at`,
      () => mem.documents.filter((d) => d.origination_id === originationId || d.originationId === originationId)
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/documents", async (req, res) => {
  const data = req.body;
  const now = new Date().toISOString();
  try {
    const result = await dbQuery(
      async (sql) => {
        // Upsert: if doc with same origination_id + tipo exists, update it
        const existing = await sql`
          SELECT id FROM documents WHERE origination_id = ${data.originationId} AND tipo = ${data.tipo} LIMIT 1`;
        if (existing.length > 0) {
          const rows = await sql`
            UPDATE documents SET image_data = ${data.imageData}, ocr_result = ${data.ocrResult || null},
            ocr_confidence = ${data.ocrConfidence || "media"}, status = ${data.status || "captured"}, edited_data = ${data.editedData || null}
            WHERE id = ${existing[0].id} RETURNING *`;
          return rows[0];
        }
        const rows = await sql`
          INSERT INTO documents (origination_id, tipo, image_data, ocr_result, ocr_confidence, edited_data, status, created_at)
          VALUES (${data.originationId}, ${data.tipo}, ${data.imageData}, ${data.ocrResult || null}, ${data.ocrConfidence || "media"}, ${data.editedData || null}, ${data.status || "captured"}, ${now})
          RETURNING *`;
        return rows[0];
      },
      () => {
        // In-memory upsert
        const existingIdx = mem.documents.findIndex((d) =>
          (d.origination_id === data.originationId || d.originationId === data.originationId) && d.tipo === data.tipo
        );
        if (existingIdx >= 0) {
          Object.assign(mem.documents[existingIdx], data);
          return mem.documents[existingIdx];
        }
        const id = mem._nextId.documents++;
        const doc = { id, origination_id: data.originationId, originationId: data.originationId, ...data, created_at: now, createdAt: now };
        mem.documents.push(doc);
        return doc;
      }
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// VEHICLES
// ============================================================

app.get("/api/vehicles", async (_req, res) => {
  try {
    const result = await dbQuery(
      async (sql) => await sql`SELECT * FROM vehicles_inventory ORDER BY created_at DESC`,
      () => [...mem.vehicles].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/vehicles", async (req, res) => {
  const data = req.body;
  const now = new Date().toISOString();
  try {
    const result = await dbQuery(
      async (sql) => {
        const rows = await sql`
          INSERT INTO vehicles_inventory (marca, modelo, variante, anio, color, niv, placas, num_serie, num_motor,
            cmu_valor, costo_adquisicion, costo_reparacion, status, kit_gnv_instalado, created_at, updated_at)
          VALUES (${data.marca}, ${data.modelo}, ${data.variante || null}, ${data.anio}, ${data.color || null},
            ${data.niv || null}, ${data.placas || null}, ${data.numSerie || null}, ${data.numMotor || null},
            ${data.cmuValor || null}, ${data.costoAdquisicion || null}, ${data.costoReparacion || null},
            ${data.status || "disponible"}, ${data.kitGnvInstalado || 0}, ${now}, ${now})
          RETURNING *`;
        return rows[0];
      },
      () => {
        const id = mem._nextId.vehicles++;
        const v = { id, ...data, created_at: now, updated_at: now };
        mem.vehicles.push(v);
        return v;
      }
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// EVALUATIONS
// ============================================================

app.post("/api/evaluations", async (req, res) => {
  const data = req.body;
  const now = new Date().toISOString();
  try {
    const result = await dbQuery(
      async (sql) => {
        const rows = await sql`
          INSERT INTO opportunities (model_id, cmu_used, insurer_price, repair_estimate, total_cost,
            purchase_pct, margin, tir_annual, moic, decision, decision_level, explanation, city, created_at)
          VALUES (${data.modelId}, ${data.cmuUsed}, ${data.insurerPrice}, ${data.repairEstimate}, ${data.totalCost},
            ${data.purchasePct}, ${data.margin}, ${data.tirAnnual}, ${data.moic}, ${data.decision},
            ${data.decisionLevel}, ${data.explanation}, ${data.city || "Aguascalientes"}, NOW())
          RETURNING *`;
        return rows[0];
      },
      () => {
        const id = mem._nextId.evaluations++;
        const evaluation = { id, ...data, created_at: now };
        mem.evaluations.push(evaluation);
        return evaluation;
      }
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/evaluations", async (_req, res) => {
  try {
    const result = await dbQuery(
      async (sql) => await sql`SELECT * FROM opportunities ORDER BY created_at DESC`,
      () => [...mem.evaluations].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// STATS (Panel CMU)
// ============================================================

app.get("/api/stats", async (_req, res) => {
  try {
    const result = await dbQuery(
      async (sql) => {
        const vehicles = await sql`SELECT status, COUNT(*)::int as count FROM vehicles_inventory GROUP BY status`;
        const originations = await sql`SELECT estado, COUNT(*)::int as count FROM originations GROUP BY estado`;
        const totalVehicles = await sql`SELECT COUNT(*)::int as total FROM vehicles_inventory`;
        const totalOriginations = await sql`SELECT COUNT(*)::int as total FROM originations`;
        return {
          vehiclesByStatus: vehicles,
          originationsByEstado: originations,
          totalVehicles: totalVehicles[0]?.total || 0,
          totalOriginations: totalOriginations[0]?.total || 0,
        };
      },
      () => {
        const vByStatus = {};
        mem.vehicles.forEach((v) => { vByStatus[v.status] = (vByStatus[v.status] || 0) + 1; });
        const oByEstado = {};
        mem.originations.forEach((o) => { oByEstado[o.estado] = (oByEstado[o.estado] || 0) + 1; });
        return {
          vehiclesByStatus: Object.entries(vByStatus).map(([status, count]) => ({ status, count })),
          originationsByEstado: Object.entries(oByEstado).map(([estado, count]) => ({ estado, count })),
          totalVehicles: mem.vehicles.length,
          totalOriginations: mem.originations.length,
        };
      }
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PLACEHOLDER INTEGRATIONS
// ============================================================

app.post("/api/mifiel/sign", (req, res) => {
  const { folio, documentType, signerName, signerEmail } = req.body || {};
  console.log(`[Mifiel] Solicitud de firma — Folio: ${folio}`);
  res.json({
    success: true, placeholder: true,
    message: "Integración Mifiel pendiente.",
    data: { documentId: `mfl_${Date.now()}`, folio, status: "pending_signature", widgetUrl: null, createdAt: new Date().toISOString() },
  });
});

// ============================================================
// TWILIO OTP — Real Verify integration
// ============================================================
let twilioClient = null;
let twilioVerifyServiceSid = null;

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;

async function getTwilioClient() {
  if (twilioClient) return twilioClient;
  if (!TWILIO_SID || !TWILIO_TOKEN) {
    console.warn("[Twilio] No credentials — OTP will run in simulation mode");
    return null;
  }
  try {
    const twilio = (await import("twilio")).default;
    twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
    console.log("[Twilio] Client initialized");
    return twilioClient;
  } catch (err) {
    console.error("[Twilio] Failed to init client:", err.message);
    return null;
  }
}

async function getOrCreateVerifyService() {
  if (twilioVerifyServiceSid) return twilioVerifyServiceSid;
  const client = await getTwilioClient();
  if (!client) return null;
  try {
    const service = await client.verify.v2.services.create({
      friendlyName: "CMU Originación OTP",
      codeLength: 6,
    });
    twilioVerifyServiceSid = service.sid;
    console.log("[Twilio] Verify Service created:", service.sid);
    return twilioVerifyServiceSid;
  } catch (err) {
    console.error("[Twilio] Failed to create Verify Service:", err.message);
    return null;
  }
}

app.post("/api/otp/send", async (req, res) => {
  const { phone, originationId } = req.body || {};
  if (!phone) return res.status(400).json({ error: "Phone required" });

  // Format phone for Mexico if needed
  let formattedPhone = phone;
  if (!formattedPhone.startsWith("+")) {
    formattedPhone = formattedPhone.replace(/^\D+/g, "");
    if (formattedPhone.length === 10) formattedPhone = "+52" + formattedPhone;
    else if (formattedPhone.length === 12 && formattedPhone.startsWith("52")) formattedPhone = "+" + formattedPhone;
    else formattedPhone = "+" + formattedPhone;
  }

  console.log(`[OTP] Send request — phone: ${formattedPhone}, origination: ${originationId}`);

  const serviceSid = await getOrCreateVerifyService();
  if (serviceSid) {
    try {
      const verification = await twilioClient.verify.v2
        .services(serviceSid)
        .verifications.create({ to: formattedPhone, channel: "sms" });
      console.log(`[OTP] Verification sent — SID: ${verification.sid}, status: ${verification.status}`);

      // Update origination otp_phone if we have originationId
      if (originationId) {
        try {
          await dbQuery(
            async (sql) => await sql`UPDATE originations SET otp_phone = ${formattedPhone}, updated_at = ${new Date().toISOString()} WHERE id = ${originationId}`,
            () => {
              const orig = mem.originations.find((o) => o.id === originationId);
              if (orig) orig.otp_phone = formattedPhone;
            }
          );
        } catch (_) {}
      }

      return res.json({ success: true, status: verification.status, phone: formattedPhone });
    } catch (err) {
      console.error(`[OTP] Send failed:`, err.message);
      // Fall through to simulation if Twilio fails (e.g., trial account restrictions)
      return res.json({
        success: true,
        simulated: true,
        status: "pending",
        phone: formattedPhone,
        note: `Twilio error: ${err.message}. Simulando OTP.`,
      });
    }
  }

  // Simulation mode (no Twilio credentials)
  res.json({ success: true, simulated: true, status: "pending", phone: formattedPhone });
});

app.post("/api/otp/verify", async (req, res) => {
  const { phone, code, originationId } = req.body || {};
  if (!phone || !code) return res.status(400).json({ error: "Phone and code required" });

  let formattedPhone = phone;
  if (!formattedPhone.startsWith("+")) {
    formattedPhone = formattedPhone.replace(/^\D+/g, "");
    if (formattedPhone.length === 10) formattedPhone = "+52" + formattedPhone;
    else if (formattedPhone.length === 12 && formattedPhone.startsWith("52")) formattedPhone = "+" + formattedPhone;
    else formattedPhone = "+" + formattedPhone;
  }

  console.log(`[OTP] Verify request — phone: ${formattedPhone}, code: ${code}, origination: ${originationId}`);

  const serviceSid = await getOrCreateVerifyService();
  if (serviceSid) {
    try {
      const check = await twilioClient.verify.v2
        .services(serviceSid)
        .verificationChecks.create({ to: formattedPhone, code });
      console.log(`[OTP] Check result — status: ${check.status}`);

      if (check.status === "approved") {
        // Mark origination as verified
        if (originationId) {
          try {
            await dbQuery(
              async (sql) => await sql`UPDATE originations SET otp_verified = 1, updated_at = ${new Date().toISOString()} WHERE id = ${originationId}`,
              () => {
                const orig = mem.originations.find((o) => o.id === originationId);
                if (orig) { orig.otp_verified = 1; orig.otpVerified = 1; }
              }
            );
          } catch (_) {}
        }
        return res.json({ success: true, status: "approved", verified: true });
      } else {
        return res.json({ success: false, status: check.status, verified: false, message: "Código incorrecto" });
      }
    } catch (err) {
      console.error(`[OTP] Verify failed:`, err.message);
      // Simulation fallback
    }
  }

  // Simulation fallback — accept any 6-digit code
  if (code && code.length === 6) {
    if (originationId) {
      try {
        await dbQuery(
          async (sql) => await sql`UPDATE originations SET otp_verified = 1, updated_at = ${new Date().toISOString()} WHERE id = ${originationId}`,
          () => {
            const orig = mem.originations.find((o) => o.id === originationId);
            if (orig) { orig.otp_verified = 1; orig.otpVerified = 1; }
          }
        );
      } catch (_) {}
    }
    return res.json({ success: true, simulated: true, status: "approved", verified: true });
  }
  res.json({ success: false, status: "failed", verified: false, message: "Código incorrecto" });
});

app.post("/api/twilio/notify", (req, res) => {
  const { phone, message, channel } = req.body || {};
  console.log(`[Twilio] Notificación — Tel: ${phone}`);
  res.json({
    success: true, placeholder: true,
    message: "Integración Twilio pendiente.",
    data: { messageId: `twl_${Date.now()}`, to: phone, channel: channel || "sms", status: "queued", createdAt: new Date().toISOString() },
  });
});

app.post("/api/conekta/charge", (req, res) => {
  const { folio, amount, customerName } = req.body || {};
  console.log(`[Conekta] Cargo — Folio: ${folio}`);
  res.json({
    success: true, placeholder: true,
    message: "Integración Conekta pendiente.",
    data: { chargeId: `cnk_${Date.now()}`, folio, amount, currency: "MXN", status: "pending", createdAt: new Date().toISOString() },
  });
});

// --- Health check ---
app.get("/api/health", async (_req, res) => {
  let dbOk = false;
  if (sql) {
    try {
      await sql`SELECT 1`;
      dbOk = true;
    } catch (_) {}
  }
  res.json({ status: "ok", database: dbOk ? "connected" : "unavailable", timestamp: new Date().toISOString() });
});

// --- Serve static frontend ---
const publicDir = path.join(__dirname, "dist", "public");
app.use(express.static(publicDir));
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// --- Start ---
app.listen(PORT, "0.0.0.0", () => {
  console.log(`CMU Decision Engine — listening on port ${PORT}`);
  console.log(`  Database: ${DATABASE_URL ? "Neon PostgreSQL" : "In-memory fallback"}`);
  console.log(`  Static files: ${publicDir}`);
});
