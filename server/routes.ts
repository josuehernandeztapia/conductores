import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { evaluateOpportunity } from "./evaluation-engine";
import { generateConvenioValidacion, generateContratoCompraventa } from "./contract-pdf";
import type { EvaluationInput, RepairEstimateResult, CmuBulkUpdateRequest } from "@shared/schema";
import Anthropic from "@anthropic-ai/sdk";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // ===== AUTH =====
  app.post("/api/auth/pin", async (req, res) => {
    try {
      const { pin } = req.body;
      if (!pin || typeof pin !== "string") {
        return res.status(400).json({ success: false, message: "PIN requerido" });
      }
      const promoter = await storage.getPromoterByPin(pin);
      if (!promoter) {
        return res.status(401).json({ success: false, message: "PIN incorrecto" });
      }
      return res.json({
        success: true,
        promoter: { id: promoter.id, name: promoter.name },
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // ===== MOTOR CMU (existing) =====

  app.get("/api/models", async (_req, res) => {
    const options = await storage.getModelOptions();
    return res.json(options);
  });

  app.post("/api/evaluate", async (req, res) => {
    try {
      const input: EvaluationInput = req.body;
      if (!input.cmu || !input.insurerPrice || input.repairEstimate == null) {
        return res.status(400).json({ message: "Todos los campos son obligatorios" });
      }
      const models = await storage.getModels();
      let modelData = input.modelId
        ? models.find((m) => m.id === input.modelId)
        : models.find((m) => m.slug === input.modelSlug && m.year === input.year);
      if (!modelData) modelData = models.find((m) => m.slug === input.modelSlug);
      if (!modelData) return res.status(404).json({ message: "Modelo no encontrado en catálogo" });

      const result = evaluateOpportunity(input, {
        brand: modelData.brand, model: modelData.model, variant: modelData.variant,
        slug: modelData.slug, purchaseBenchmarkPct: modelData.purchaseBenchmarkPct,
      });

      await storage.saveOpportunity({
        modelId: modelData.id, cmuUsed: result.cmu, insurerPrice: result.insurerPrice,
        repairEstimate: result.repairEstimate, totalCost: result.totalCost,
        purchasePct: result.purchasePct, margin: result.margin,
        tirAnnual: result.tirAnnual, moic: result.moic,
        decision: result.decision, decisionLevel: result.decisionLevel,
        explanation: result.explanation, city: result.city,
      });

      return res.json(result);
    } catch (err: any) {
      console.error("Evaluation error:", err);
      return res.status(500).json({ message: err.message || "Error interno" });
    }
  });

  app.post("/api/estimate-repair", async (req, res) => {
    try {
      const { images } = req.body as { images: string[] };
      if (!images || !Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ message: "Se requiere al menos 1 imagen" });
      }
      if (images.length > 6) {
        return res.status(400).json({ message: "Máximo 6 imágenes permitidas" });
      }

      const client = new Anthropic();
      const content: Anthropic.MessageCreateParams["messages"][0]["content"] = [];

      for (const img of images) {
        const match = img.match(/^data:(image\/\w+);base64,(.+)$/);
        if (!match) return res.status(400).json({ message: "Formato de imagen inválido." });
        content.push({
          type: "image",
          source: { type: "base64", media_type: match[1] as any, data: match[2] },
        });
      }

      content.push({
        type: "text",
        text: `Eres un perito automotriz experto en vehículos siniestrados del mercado mexicano (Nissan March, Chevrolet Aveo, Suzuki V-Drive). Analiza las imágenes del vehículo dañado y estima el costo de reparación.

Clasifica la severidad del daño:
- "leve": daño cosmético menor. Reparación $3,000 - $10,000 MXN.
- "medio": daño estructural menor. Reparación $10,000 - $25,000 MXN.
- "severo": daño estructural importante. Reparación $25,000 - $45,000 MXN.
- "destruccion_total": destrucción total. Reparación $45,000+ MXN.

Responde SOLO con JSON válido:
{
  "severity": "leve" | "medio" | "severo" | "destruccion_total",
  "estimated_repair_min": <número>,
  "estimated_repair_max": <número>,
  "confidence": "alta" | "media" | "baja",
  "details": "<descripción breve en español>"
}`,
      });

      const message = await client.messages.create({
        model: "claude_sonnet_4_6", max_tokens: 512,
        messages: [{ role: "user", content }],
      });

      const textBlock = message.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        return res.status(500).json({ message: "No se recibió respuesta del modelo" });
      }

      let parsed: any;
      try {
        const jsonStr = textBlock.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        return res.status(500).json({ message: "Error al interpretar la respuesta del modelo" });
      }

      const severityLabels: Record<string, string> = {
        leve: "Daño Leve", medio: "Daño Medio", severo: "Daño Severo", destruccion_total: "Destrucción Total",
      };

      const min = Math.round(parsed.estimated_repair_min / 1000) * 1000;
      const max = Math.round(parsed.estimated_repair_max / 1000) * 1000;
      const mid = Math.round(((min + max) / 2) / 1000) * 1000;

      const result: RepairEstimateResult = {
        severity: parsed.severity === "destruccion_total" ? "destrucción_total" : parsed.severity,
        severityLabel: severityLabels[parsed.severity] || "Desconocido",
        estimatedRepairMin: min, estimatedRepairMax: max, estimatedRepairMid: mid,
        confidence: parsed.confidence, details: parsed.details,
      };

      return res.json(result);
    } catch (err: any) {
      console.error("Estimate repair error:", err);
      return res.status(500).json({ message: err.message || "Error al estimar reparación" });
    }
  });

  // CMU external update endpoints
  app.put("/api/models/:id/cmu", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { cmu, source, cmuMin, cmuMax, cmuMedian, sampleCount } = req.body;
      if (!cmu || typeof cmu !== "number") {
        return res.status(400).json({ message: "Se requiere un valor CMU numérico" });
      }
      const updated = await storage.updateModelCmu(id, cmu, source || "manual", { cmuMin, cmuMax, cmuMedian, sampleCount });
      if (!updated) return res.status(404).json({ message: "Modelo no encontrado" });
      return res.json({
        message: "CMU actualizado",
        model: `${updated.brand} ${updated.model} ${updated.variant || ""} ${updated.year}`.trim(),
        cmu: updated.cmu, source: updated.cmuSource, updatedAt: updated.cmuUpdatedAt,
      });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/cmu/bulk-update", async (req, res) => {
    try {
      const { entries, source } = req.body as CmuBulkUpdateRequest;
      if (!entries || !Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ message: "Se requiere al menos una entrada" });
      }
      if (!source) return res.status(400).json({ message: "Se requiere indicar la fuente (source)" });
      const result = await storage.bulkUpdateCmu(entries, source);
      return res.json({ message: `${result.updated} modelos actualizados`, ...result, source, timestamp: new Date().toISOString() });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/cmu/catalog", async (_req, res) => {
    const models = await storage.getModels();
    return res.json(models.map((m) => ({
      id: m.id, brand: m.brand, model: m.model, variant: m.variant, year: m.year,
      cmu: m.cmu, cmuSource: m.cmuSource, cmuUpdatedAt: m.cmuUpdatedAt,
      cmuMin: m.cmuMin, cmuMax: m.cmuMax, cmuMedian: m.cmuMedian,
      cmuSampleCount: m.cmuSampleCount, purchaseBenchmarkPct: m.purchaseBenchmarkPct, slug: m.slug,
    })));
  });

  app.get("/api/opportunities", async (_req, res) => {
    return res.json(await storage.getOpportunities());
  });

  // ===== VEHICLES INVENTORY =====

  app.get("/api/vehicles", async (_req, res) => {
    const status = typeof _req.query.status === "string" ? _req.query.status : undefined;
    return res.json(await storage.listVehicles(status ? { status } : undefined));
  });

  app.post("/api/vehicles", async (req, res) => {
    try {
      const now = new Date().toISOString();
      const vehicle = await storage.createVehicle({
        ...req.body,
        createdAt: now,
        updatedAt: now,
      });
      return res.json(vehicle);
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/vehicles/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updated = await storage.updateVehicle(id, req.body);
      if (!updated) return res.status(404).json({ message: "Vehículo no encontrado" });
      return res.json(updated);
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // ===== ORIGINATIONS =====

  app.get("/api/originations", async (req, res) => {
    const estado = typeof req.query.estado === "string" ? req.query.estado : undefined;
    return res.json(await storage.listOriginations(estado ? { estado } : undefined));
  });

  app.get("/api/originations/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    const orig = await storage.getOrigination(id);
    if (!orig) return res.status(404).json({ message: "Folio no encontrado" });
    return res.json(orig);
  });

  app.post("/api/originations", async (req, res) => {
    try {
      const { tipo, perfilTipo, taxista } = req.body;
      if (!tipo || !perfilTipo || !taxista?.nombre || !taxista?.apellidoPaterno || !taxista?.telefono) {
        return res.status(400).json({ message: "Datos incompletos" });
      }

      const now = new Date().toISOString();

      // Create taxista first
      const newTaxista = await storage.createTaxista({
        nombre: taxista.nombre,
        apellidoPaterno: taxista.apellidoPaterno,
        apellidoMaterno: taxista.apellidoMaterno || null,
        telefono: taxista.telefono,
        perfilTipo,
        ciudad: "Aguascalientes",
        estado: "Aguascalientes",
        createdAt: now,
        curp: null, rfc: null, email: null, direccion: null, codigoPostal: null,
        gnvHistorialLeq: null, gnvMesesHistorial: null, ticketsGasolinaMensual: null,
        clabe: null, banco: null, folio: null,
      });

      // Generate folio
      const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, "");
      const prefix = tipo === "validacion" ? "CMU-VAL" : "CMU-CPV";
      const seq = await storage.getNextFolioSequence(prefix, dateStr);
      const folio = `${prefix}-${dateStr}-${String(seq).padStart(3, "0")}`;

      // Create origination
      const origination = await storage.createOrigination({
        folio,
        tipo,
        estado: "BORRADOR",
        taxistaId: newTaxista.id,
        promoterId: 1, // Only one promoter: Ángeles Mireles
        vehicleInventoryId: null,
        perfilTipo,
        currentStep: 1,
        datosIne: null, datosCsf: null, datosComprobante: null, datosConcesion: null,
        datosEstadoCuenta: null, datosHistorial: null, datosFactura: null, datosMembresia: null,
        otpCode: null, otpVerified: 0, otpPhone: taxista.telefono,
        selfieUrl: null, vehiclePhotos: null,
        contractType: null, contractUrl: null, contractGeneratedAt: null,
        mifielDocumentId: null, mifielStatus: null,
        notes: null, rejectionReason: null,
        createdAt: now, updatedAt: now,
      });

      // Update taxista with folio
      await storage.updateTaxista(newTaxista.id, { folio });

      return res.json({ origination, taxista: newTaxista });
    } catch (err: any) {
      console.error("Create origination error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/originations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updated = await storage.updateOrigination(id, req.body);
      if (!updated) return res.status(404).json({ message: "Folio no encontrado" });
      return res.json(updated);
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // ===== DOCUMENTS + OCR =====

  app.get("/api/originations/:id/documents", async (req, res) => {
    const id = parseInt(req.params.id);
    return res.json(await storage.getDocumentsByOrigination(id));
  });

  app.post("/api/originations/ocr", async (req, res) => {
    try {
      const { originationId, docType, imageData } = req.body;
      if (!originationId || !docType || !imageData) {
        return res.status(400).json({ message: "Datos incompletos" });
      }

      const now = new Date().toISOString();

      // Check if document already exists, update or create
      let doc = await storage.getDocumentByOriginationAndType(originationId, docType);

      // Run OCR with Claude Vision
      const client = new Anthropic();

      const match = imageData.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!match) {
        // Save without OCR for non-image files
        if (doc) {
          await storage.updateDocument(doc.id, { imageData, status: "captured" });
        } else {
          doc = await storage.createDocument({
            originationId, tipo: docType, imageData,
            ocrResult: null, ocrConfidence: null, editedData: null,
            status: "captured", createdAt: now,
          });
        }
        return res.json({ extractedData: {}, confidence: "baja" });
      }

      // Build OCR prompt based on document type
      const ocrPrompts: Record<string, string> = {
        ine_frente: 'Extrae de esta INE (frente): nombre, apellido_paterno, apellido_materno, direccion, clave_elector, seccion, vigencia. JSON puro.',
        ine_reverso: 'Extrae de esta INE (reverso): curp, numero_ine. JSON puro.',
        csf: 'Extrae de esta Constancia de Situación Fiscal: rfc, razon_social, regimen_fiscal, domicilio_fiscal, codigo_postal. JSON puro.',
        comprobante_domicilio: 'Extrae de este comprobante de domicilio: direccion, tipo_servicio, fecha_emision, nombre_titular. JSON puro.',
        concesion: 'Extrae de esta concesión de taxi: numero_concesion, titular, vigencia, ruta, municipio. JSON puro.',
        estado_cuenta: 'Extrae de este estado de cuenta: banco, clabe, titular, numero_cuenta. JSON puro.',
        historial_gnv: 'Extrae de este historial GNV: promedio_leq_mensual, meses_historial, estacion. JSON puro.',
        tickets_gasolina: 'Extrae de estos tickets de gasolina: gasto_promedio_mensual, numero_tickets, estacion. JSON puro.',
        factura_vehiculo: 'Extrae de esta factura vehicular: marca, modelo, anio, num_serie, niv, propietario, valor_factura. JSON puro.',
        carta_membresia: 'Extrae de esta carta de membresía: numero_membresia, titular, vigencia, organizacion. JSON puro.',
      };

      const prompt = ocrPrompts[docType] || 'Extrae todos los campos relevantes de este documento. Responde con JSON puro.';

      const message = await client.messages.create({
        model: "claude_sonnet_4_6",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: match[1] as any, data: match[2] } },
            { type: "text", text: `${prompt}\n\nResponde SOLO con un objeto JSON válido (sin markdown, sin backticks, sin explicación adicional).` },
          ],
        }],
      });

      const textBlock = message.content.find((b) => b.type === "text");
      let extractedData: Record<string, any> = {};
      let confidence = "media";

      if (textBlock && textBlock.type === "text") {
        try {
          const jsonStr = textBlock.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          extractedData = JSON.parse(jsonStr);
          confidence = "alta";
        } catch {
          extractedData = { raw_text: textBlock.text };
          confidence = "baja";
        }
      }

      // Save/update document
      if (doc) {
        await storage.updateDocument(doc.id, {
          imageData,
          ocrResult: JSON.stringify(extractedData),
          ocrConfidence: confidence,
          editedData: JSON.stringify(extractedData),
          status: "ocr_done",
        });
      } else {
        doc = await storage.createDocument({
          originationId, tipo: docType, imageData,
          ocrResult: JSON.stringify(extractedData),
          ocrConfidence: confidence,
          editedData: JSON.stringify(extractedData),
          status: "ocr_done", createdAt: now,
        });
      }

      // Also update origination with extracted data based on doc type
      const orig = await storage.getOrigination(originationId);
      if (orig) {
        const dataFieldMap: Record<string, string> = {
          ine_frente: "datosIne",
          ine_reverso: "datosIne", // merge with existing
          csf: "datosCsf",
          comprobante_domicilio: "datosComprobante",
          concesion: "datosConcesion",
          estado_cuenta: "datosEstadoCuenta",
          historial_gnv: "datosHistorial",
          tickets_gasolina: "datosHistorial",
          factura_vehiculo: "datosFactura",
          carta_membresia: "datosMembresia",
        };

        const field = dataFieldMap[docType];
        if (field) {
          const existing = (orig as any)[field] ? JSON.parse((orig as any)[field]) : {};
          const merged = { ...existing, ...extractedData };
          await storage.updateOrigination(originationId, { [field]: JSON.stringify(merged) } as any);
        }
      }

      return res.json({ extractedData, confidence, documentId: doc.id });
    } catch (err: any) {
      console.error("OCR error:", err);
      return res.status(500).json({ message: err.message || "Error en OCR" });
    }
  });

  app.patch("/api/originations/:oid/documents/:tipo", async (req, res) => {
    try {
      const oid = parseInt(req.params.oid);
      const tipo = req.params.tipo;
      const { editedData } = req.body;

      const doc = await storage.getDocumentByOriginationAndType(oid, tipo);
      if (!doc) return res.status(404).json({ message: "Documento no encontrado" });

      await storage.updateDocument(doc.id, {
        editedData: JSON.stringify(editedData),
        status: "verified",
      });

      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // ===== OTP =====

  app.post("/api/originations/:id/otp/send", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      // Simulated OTP
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await storage.updateOrigination(id, { otpCode: code } as any);
      return res.json({ success: true, code, message: "OTP enviado (simulado)" });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/originations/:id/otp/verify", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { code } = req.body;
      const orig = await storage.getOrigination(id);
      if (!orig) return res.status(404).json({ message: "Folio no encontrado" });

      if (orig.otpCode === code) {
        await storage.updateOrigination(id, { otpVerified: 1 } as any);
        return res.json({ verified: true });
      }
      return res.json({ verified: false });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // ===== CONTRACT GENERATION =====

  app.post("/api/originations/:id/contract", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const orig = await storage.getOrigination(id);
      if (!orig) return res.status(404).json({ message: "Folio no encontrado" });

      const now = new Date().toISOString();
      const contractType = orig.tipo === "validacion" ? "convenio_validacion" : "contrato_compraventa";

      // Get taxista and vehicle data
      const taxista = orig.taxistaId ? await storage.getTaxista(orig.taxistaId) : null;
      const vehicle = orig.vehicleInventoryId ? await storage.getVehicle(orig.vehicleInventoryId) : null;

      // Generate real PDF
      const pdfBuffer = contractType === "convenio_validacion"
        ? await generateConvenioValidacion(orig, taxista, vehicle)
        : await generateContratoCompraventa(orig, taxista, vehicle);

      // Build contract data from origination
      const contractData = {
        folio: orig.folio,
        tipo: contractType,
        fechaGeneracion: now,
        datosIne: orig.datosIne ? JSON.parse(orig.datosIne) : {},
        datosCsf: orig.datosCsf ? JSON.parse(orig.datosCsf) : {},
        datosComprobante: orig.datosComprobante ? JSON.parse(orig.datosComprobante) : {},
        datosConcesion: orig.datosConcesion ? JSON.parse(orig.datosConcesion) : {},
        datosEstadoCuenta: orig.datosEstadoCuenta ? JSON.parse(orig.datosEstadoCuenta) : {},
        datosFactura: orig.datosFactura ? JSON.parse(orig.datosFactura) : {},
        empresa: {
          nombre: "CONDUCTORES DEL MUNDO, S.A.P.I. de C.V.",
          rfc: "CMU201119DD6",
          ciudad: "Aguascalientes",
        },
        condiciones: {
          plazo: 36,
          tasaAnual: 0.299,
          anticipoCapital: 50000,
          recaudoGnv: 4400,
        },
        pdfSize: pdfBuffer.length,
      };

      const contract = await storage.createContract({
        originationId: id,
        tipo: contractType,
        folio: orig.folio,
        contractData: JSON.stringify(contractData),
        pdfUrl: `/api/originations/${id}/contract/pdf`,
        pdfGeneratedAt: now,
        status: "generated",
        createdAt: now,
        mifielDocumentId: null,
        signedAt: null,
        signedByTaxista: 0,
        signedByPromotora: 0,
        signedByCmu: 0,
      });

      // Store PDF buffer in memory cache for download (in production, this would go to S3)
      pdfCache.set(id, { buffer: pdfBuffer, folio: orig.folio, type: contractType });

      // Update origination
      await storage.updateOrigination(id, {
        contractType,
        contractUrl: contract.pdfUrl,
        contractGeneratedAt: now,
        estado: "GENERADO",
      } as any);

      return res.json({ contract, message: "Contrato generado", pdfSize: pdfBuffer.length });
    } catch (err: any) {
      console.error("Contract generation error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  // Download contract PDF
  app.get("/api/originations/:id/contract/pdf", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      
      // Check cache first
      let cached = pdfCache.get(id);
      
      if (!cached) {
        // Regenerate PDF on the fly
        const orig = await storage.getOrigination(id);
        if (!orig) return res.status(404).json({ message: "Folio no encontrado" });

        const taxista = orig.taxistaId ? await storage.getTaxista(orig.taxistaId) : null;
        const vehicle = orig.vehicleInventoryId ? await storage.getVehicle(orig.vehicleInventoryId) : null;
        const contractType = orig.tipo === "validacion" ? "convenio_validacion" : "contrato_compraventa";

        const pdfBuffer = contractType === "convenio_validacion"
          ? await generateConvenioValidacion(orig, taxista, vehicle)
          : await generateContratoCompraventa(orig, taxista, vehicle);

        cached = { buffer: pdfBuffer, folio: orig.folio, type: contractType };
        pdfCache.set(id, cached);
      }

      const filename = `${cached.folio}-${cached.type === "convenio_validacion" ? "convenio" : "compraventa"}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
      res.setHeader("Content-Length", cached.buffer.length);
      return res.send(cached.buffer);
    } catch (err: any) {
      console.error("PDF download error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  return httpServer;
}

// In-memory PDF cache (in production, use S3 or similar)
const pdfCache = new Map<number, { buffer: Buffer; folio: string; type: string }>();
