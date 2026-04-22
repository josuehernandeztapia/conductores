import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { createHmac } from "crypto";
import { storage } from "./storage";
import { evaluateOpportunity } from "./evaluation-engine";
import { generateConvenioValidacion, generateContratoCompraventa } from "./contract-pdf";
import * as contractEngine from "./contract-engine";
import { getBusinessRules, ruleNum, ruleStr, ruleBool, getThresholds } from "./business-rules";
import { exchangeCode, searchML, getMLAuthUrl, isMLConfigured, getMLToken } from "./ml-api";
import type { EvaluationInput, RepairEstimateResult, CmuBulkUpdateRequest } from "@shared/schema";
import Anthropic from "@anthropic-ai/sdk";
import { runAllProactiveChecks } from "./proactive-agent";
import { ejecutarCierreMensual, recordatorioDia3, recordatorioDia5, aplicarFGDia6, revisarMoraDiaria, registrarPago, generarReporteSemanal, formatCierreResumenDirector, formatFGResumen, formatMoraResumen } from "./cierre-mensual";
import { crearLigaPago, cancelarLiga, parseConektaWebhook, isConektaEnabled } from "./conekta-client";
import { cierreMensual, processNatgasCsv, processNatgasMultiProduct, parseNatgasExcel, parseNatgasCsv as parseNatgasCsvRows, formatRecaudoSummary, formatCierreReport, isDuplicateFile, markFileProcessed } from "./recaudo-engine";
import evaluacionRoutes from "./evaluacion-routes";
import { logAudit, initAuditTable, getAuditLog } from "./audit-trail";
import {
  initAvpTable,
  recordAcceptance,
  getLatestAcceptance,
  revokeAcceptance,
} from "./avp-engine";
import { initOcrProvenanceTable, getOcrHistoryForPhone } from "./ocr-provenance";
import { AVP_CURRENT_VERSION, AVP_VIGENTE_DESDE } from "@shared/schema";
import { checkOTP } from "./twilio-verify";
import { detectCanal, upsertProspect, updateProspectStatus, getPipelineStats, getPipelineList, getCanales, getProspectsNeedingFollowup, markFollowupSent, generateWhatsAppLink } from "./pipeline-ventas";
import { handleProspectMessage } from "./agent/orchestrator";
import { routeMessage } from "./message-router";
import { getSession, updateSession } from "./conversation-state";
import { getPromotor, DIRECTOR, PROMOTOR_LABEL, JOSUE_PHONE, ANGELES_PHONE } from "./team-config";
import { DOC_KEYS as VISION_DOC_KEYS, DOC_LABELS as VISION_DOC_LABELS_MAP } from "./agent/vision";

// ===== SESSION TOKEN (HMAC-signed) =====
const SESSION_SECRET = process.env.SESSION_SECRET || "cmu-internal-2026";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function createSessionToken(promoterId: number, promoterName: string): string {
  const payload = `${promoterId}|${promoterName}|${Date.now()}`;
  const sig = createHmac("sha256", SESSION_SECRET).update(payload).digest("hex").slice(0, 16);
  return Buffer.from(`${payload}|${sig}`).toString("base64");
}

function validateSessionToken(token: string): { promoterId: number; name: string } | null {
  try {
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const parts = decoded.split("|");
    if (parts.length !== 4) return null;
    const [idStr, name, tsStr, sig] = parts;
    const payload = `${idStr}|${name}|${tsStr}`;
    const expectedSig = createHmac("sha256", SESSION_SECRET).update(payload).digest("hex").slice(0, 16);
    if (sig !== expectedSig) return null;
    // Check expiry
    const ts = parseInt(tsStr);
    if (Date.now() - ts > SESSION_TTL_MS) return null;
    return { promoterId: parseInt(idStr), name };
  } catch {
    return null;
  }
}

// Paths that don't require auth
const PUBLIC_PATHS = [
  "/api/health",
  "/api/auth/login",
  "/api/auth/pin",
  "/api/whatsapp/webhook",
  "/api/whatsapp/incoming",
  "/api/whatsapp/send-outbound",
  "/api/whatsapp/send",
  "/api/ml/authorize",
  "/api/ml-callback",
  "/api/recaudo/process",
  "/api/recaudo/fix-ahorro",
  "/api/recaudo/admin",
  "/api/expedientes/bloqueados",
  "/api/mifiel/webhook",
  "/api/business-config",
  "/api/cierre/ejecutar",
  "/api/cierre/recordatorio3",
  "/api/cierre/recordatorio5",
  "/api/cierre/fg",
  "/api/cierre/mora",
  "/api/cierre/pago",
  "/api/cierre/reporte-semanal",
  "/api/conekta/webhook",
  "/api/webhooks/conekta",
  "/api/conekta/crear-liga",
  "/api/evaluacion",
  "/api/audit",
  "/api/pipeline",
  "/api/agent/sandbox",
  "/api/market-cache",  // client-side ML scraper (browser sends prices from MX)
  "/api/originacion/reporte-pdf",  // internal cron + promotora trigger
  "/api/test/",                    // ALL test endpoints
  "/api/market-prices/bulk-update", // Daily bulk price update (cron)
  "/api/metrics/funnel",
  "/api/aviso-privacidad", // LFPDPPP: operator accepts via phone + OTP, not PWA PIN
  "/api/cron/proactive", // proactive reminders cron (has x-cron-secret)
  "/api/cron/abandono", // plate abandonment detection cron (new)
  "/api/cron/aviso-dia25", // day 25 proactive status to conductor
  "/api/originations/admin", // PIN-gated admin ops (cancel/delete test folios)
  "/api/conekta/crear-liga-admin", // PIN-gated payment link creation
];

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip non-API paths
  if (!req.path.startsWith("/api/")) return next();
  // Skip public endpoints
  if (PUBLIC_PATHS.some(p => req.path.startsWith(p))) return next();
  // Skip internal requests (server calling itself — WhatsApp agent, cron, etc.)
  const host = req.headers.host || "";
  const origin = req.headers.origin || "";
  if (host.includes("localhost") && !origin) return next();
  
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No autorizado — inicia sesi\u00f3n" });
  }
  const token = authHeader.slice(7);
  const session = validateSessionToken(token);
  if (!session) {
    return res.status(401).json({ message: "Sesi\u00f3n expirada — inicia sesi\u00f3n de nuevo" });
  }
  // Attach session to request for downstream use
  (req as any).session = session;
  next();
}

// Role-based access control for sensitive endpoints
function requireRole(...allowedRoles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = (req as any).session;
    if (!session) return res.status(401).json({ message: "No autorizado" });
    // Look up role from promoters table
    try {
      const { neon } = await import("@neondatabase/serverless");
      const sql = neon(process.env.DATABASE_URL!);
      const rows = await sql`SELECT role FROM promoters WHERE id = ${session.promoterId}` as any[];
      const role = rows[0]?.role || "promotora";
      if (!allowedRoles.includes(role)) {
        return res.status(403).json({ message: "Sin permisos para esta acción" });
      }
      (req as any).role = role;
      next();
    } catch {
      next(); // If DB fails, allow (graceful degradation)
    }
  };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // ===== AUTH MIDDLEWARE =====
  app.use(authMiddleware);

  // ===== DB MIGRATION: ensure folio UNIQUE constraint =====
  try {
    const sql = (storage as any).sql;
    if (sql) {
      // Clean up duplicate folios: delete the DUP copies (keep the originals)
      const dupRows = await sql`SELECT id, folio FROM originations WHERE folio LIKE '%-DUP%'`;
      for (const row of dupRows) {
        await sql`DELETE FROM originations WHERE id = ${row.id}`;
        console.log(`[DB] Deleted duplicate folio ${row.folio} (id=${row.id})`);
      }
      // Fix any remaining duplicates (rename newer ones, then delete them)
      const dupes = await sql`
        SELECT folio, array_agg(id ORDER BY id) as ids
        FROM originations
        GROUP BY folio HAVING COUNT(*) > 1`;
      for (const dupe of dupes) {
        const ids = dupe.ids;
        // Keep the first (oldest), delete the rest
        for (let i = 1; i < ids.length; i++) {
          await sql`DELETE FROM originations WHERE id = ${ids[i]}`;
          console.log(`[DB] Deleted duplicate folio ${dupe.folio} (id=${ids[i]})`);
        }
      }
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_originations_folio ON originations (folio)`;
      console.log("[DB] folio UNIQUE index ensured");
    }
  } catch (err: any) {
    console.warn("[DB] folio index migration:", err.message);
  }

  // Migration: add GNV modalidad columns to vehicles_inventory
  try {
    const sql2 = (storage as any).sql;
    if (sql2) {
      await sql2`ALTER TABLE vehicles_inventory ADD COLUMN IF NOT EXISTS gnv_modalidad TEXT`;
      await sql2`ALTER TABLE vehicles_inventory ADD COLUMN IF NOT EXISTS descuento_gnv INTEGER`;
      console.log("[DB] gnv_modalidad columns ensured");
    }
  } catch (err: any) {
    console.warn("[DB] gnv_modalidad migration:", err.message);
  }

  // ===== HEALTH =====
  app.get("/api/health", async (_req, res) => {
    const mlToken = await getMLToken().catch(() => null);
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      ml_api: isMLConfigured() ? (mlToken ? "connected" : "needs_auth") : "not_configured",
    });
  });

  // ===== MERCADOLIBRE OAUTH =====
  app.get("/api/ml/authorize", (_req, res) => {
    if (!isMLConfigured()) return res.status(500).json({ error: "ML_CLIENT_ID/ML_CLIENT_SECRET not set" });
    res.redirect(getMLAuthUrl());
  });

  app.get("/api/ml-callback", async (req, res) => {
    const code = req.query.code as string;
    if (!code) return res.status(400).send("No code parameter");
    console.log(`[ML-OAuth] Received callback with code: ${code.substring(0, 20)}...`);
    const result = await exchangeCode(code);
    if (result.success) {
      res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2 style="color:#059669">MercadoLibre conectado</h2>
        <p>Token obtenido y guardado. Puedes cerrar esta ventana.</p>
        <p style="color:#666;font-size:14px">La API de precios de mercado ahora usa datos reales de MercadoLibre.</p>
      </body></html>`);
    } else {
      res.status(400).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2 style="color:#dc2626">Error</h2>
        <p>${result.error}</p>
        <a href="/api/ml/authorize">Reintentar</a>
      </body></html>`);
    }
  });

  app.get("/api/ml/status", async (_req, res) => {
    const token = await getMLToken().catch(() => null);
    res.json({
      configured: isMLConfigured(),
      authorized: !!token,
      authorizeUrl: isMLConfigured() ? "/api/ml/authorize" : null,
    });
  });

  // ===== MARKET PRICES CACHE (client-side scraper → DB) =====

  // Serve ML token to browser for client-side API calls
  app.get("/api/ml/token", async (_req, res) => {
    try {
      const token = await getMLToken();
      if (!token) return res.json({ token: null, error: "No ML token — authorize at /api/ml/authorize" });
      res.json({ token });
    } catch (e: any) {
      res.json({ token: null, error: e.message });
    }
  });

  // Browser sends scraped prices → server saves to cache
  app.post("/api/market-cache", async (req, res) => {
    try {
      const { brand, model, variant, year, prices, sources } = req.body;
      if (!brand || !model || !year || !prices || !Array.isArray(prices) || prices.length === 0) {
        return res.status(400).json({ error: "Requires brand, model, year, prices[]" });
      }
      const sorted = [...prices].sort((a: number, b: number) => a - b);
      const count = sorted.length;
      const min = sorted[0];
      const max = sorted[count - 1];
      const median = count % 2 === 0
        ? Math.round((sorted[count / 2 - 1] + sorted[count / 2]) / 2)
        : sorted[Math.floor(count / 2)];
      const average = Math.round(sorted.reduce((a: number, b: number) => a + b, 0) / count);

      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) return res.status(500).json({ error: "No DATABASE_URL" });
      const { neon } = await import("@neondatabase/serverless");
      const sql = neon(dbUrl);

      // Upsert: ON CONFLICT UPDATE
      await sql`
        INSERT INTO market_prices_cache (brand, model, variant, year, min_price, max_price, median_price, average_price, sample_count, prices, sources, scraped_at)
        VALUES (${brand}, ${model}, ${variant || null}, ${parseInt(year)}, ${min}, ${max}, ${median}, ${average}, ${count}, ${JSON.stringify(sorted)}, ${sources || ''}, NOW())
        ON CONFLICT (brand, model, variant, year)
        DO UPDATE SET min_price = ${min}, max_price = ${max}, median_price = ${median}, average_price = ${average}, 
                      sample_count = ${count}, prices = ${JSON.stringify(sorted)}, sources = ${sources || ''}, scraped_at = NOW()
      `;

      console.log(`[MarketCache] Saved ${brand} ${model} ${variant || ''} ${year}: $${min}-$${max} (med $${median}, ${count} prices)`);
      res.json({ success: true, brand, model, variant, year, min, max, median, average, count });
    } catch (e: any) {
      console.error("[MarketCache] Error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // List all cached prices
  app.get("/api/market-cache", async (_req, res) => {
    try {
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) return res.json([]);
      const { neon } = await import("@neondatabase/serverless");
      const sql = neon(dbUrl);
      const rows = await sql`SELECT brand, model, variant, year, min_price, max_price, median_price, average_price, sample_count, sources, scraped_at, p25, p70, p75, avg_band, source_count, warnings FROM market_prices_cache ORDER BY brand, model, variant, year`;
      res.json(rows);
    } catch (e: any) {
      res.json([]);
    }
  });

  // Get cached price for specific model (used by market-prices endpoint)
  async function getCachedPrice(brand: string, model: string, variant: string | null, year: number): Promise<{ min: number; max: number; median: number; average: number; count: number; scrapedAt: string; p25: number | null; p70: number | null; p75: number | null; avg_band: number | null; sourceCount: number; warnings: string[] } | null> {
    try {
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) return null;
      const { neon } = await import("@neondatabase/serverless");
      const sql = neon(dbUrl);
      // Try exact match first (with variant), then without
      let rows = variant
        ? await sql`SELECT * FROM market_prices_cache WHERE LOWER(brand)=LOWER(${brand}) AND LOWER(model)=LOWER(${model}) AND LOWER(variant)=LOWER(${variant}) AND year=${year} LIMIT 1`
        : [];
      if (rows.length === 0) {
        rows = await sql`SELECT * FROM market_prices_cache WHERE LOWER(brand)=LOWER(${brand}) AND LOWER(model)=LOWER(${model}) AND variant IS NULL AND year=${year} LIMIT 1`;
      }
      if (rows.length === 0) {
        // Try any variant for this brand/model/year
        rows = await sql`SELECT * FROM market_prices_cache WHERE LOWER(brand)=LOWER(${brand}) AND LOWER(model)=LOWER(${model}) AND year=${year} ORDER BY scraped_at DESC LIMIT 1`;
      }
      if (rows.length === 0) return null;
      const r = rows[0];
      // Only use cache if less than 7 days old
      const age = Date.now() - new Date(r.scraped_at).getTime();
      if (age > 7 * 24 * 60 * 60 * 1000) {
        console.log(`[MarketCache] Cache for ${brand} ${model} ${year} is ${Math.round(age / 86400000)}d old — stale`);
        return null;
      }
      return {
        min: r.min_price, max: r.max_price, median: r.median_price, average: r.average_price,
        count: r.sample_count, scrapedAt: r.scraped_at,
        p25: r.p25 || null, p70: r.p70 || null, p75: r.p75 || null,
        avg_band: r.avg_band || null, sourceCount: r.source_count || 0,
        warnings: r.warnings || [],
      };
    } catch { return null; }
  }

  // ===== BUSINESS CONFIG (SSOT for client) =====
  app.get("/api/business-config", async (_req, res) => {
    try {
      const [rules, fuelPrices] = await Promise.all([
        getBusinessRules(),
        storage.getFuelPrices(),
      ]);
      const thresholds = getThresholds(rules);
      res.json({
        // Consumo
        leqBase: ruleNum(rules, "leq_base", 400),
        leqMinimo: ruleNum(rules, "leq_minimo", 300),
        sobreprecioGnv: ruleNum(rules, "sobreprecio_gnv", 11),
        // Financiamiento
        plazoMeses: ruleNum(rules, "plazo_meses", 36),
        tasaAnual: ruleNum(rules, "tasa_anual", 0.299),
        // Fondo de Garantía
        fgInicial: ruleNum(rules, "fg_inicial", 8000),
        fgMensual: ruleNum(rules, "fg_mensual", 334),
        fgTecho: ruleNum(rules, "fg_techo", 20000),
        // Cobranza
        moraFee: ruleNum(rules, "mora_fee", 250),
        mesesRescision: ruleNum(rules, "meses_rescision", 3),
        // Umbrales (porcentajes)
        excelentePct: thresholds.excellentPct,
        buenNegocioPctMin: thresholds.goodPctMin,
        buenNegocioPctMax: thresholds.goodPctMax,
        marginalPctMin: thresholds.marginalPctMin,
        marginalPctMax: thresholds.marginalPctMax,
        noConvienePct: thresholds.noConvienePct,
        // Fuel prices
        precioGnv: fuelPrices.gnv,
        precioMagna: fuelPrices.magna,
        precioPremium: fuelPrices.premium,
        // Computed: recaudo GNV mensual
        gnvRevenueMes: ruleNum(rules, "leq_base", 400) * ruleNum(rules, "sobreprecio_gnv", 11),
      });
    } catch (e: any) {
      console.error("[business-config]", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ===== AUTH =====
  // Rate limiting: 3 failed attempts per IP → 30s cooldown
  const loginAttempts = new Map<string, { count: number; lastAttempt: number }>();
  const MAX_ATTEMPTS = 3;
  const COOLDOWN_MS = 30_000; // 30 seconds

  function checkRateLimit(ip: string): { blocked: boolean; remaining?: number } {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry) return { blocked: false };
    if (now - entry.lastAttempt > COOLDOWN_MS) {
      loginAttempts.delete(ip);
      return { blocked: false };
    }
    if (entry.count >= MAX_ATTEMPTS) {
      const remaining = Math.ceil((COOLDOWN_MS - (now - entry.lastAttempt)) / 1000);
      return { blocked: true, remaining };
    }
    return { blocked: false };
  }

  function recordFailedAttempt(ip: string) {
    const entry = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    entry.count++;
    entry.lastAttempt = Date.now();
    loginAttempts.set(ip, entry);
    console.log(`[Auth] Failed login from ${ip} (attempt ${entry.count}/${MAX_ATTEMPTS})`);
  }

  function clearAttempts(ip: string) {
    loginAttempts.delete(ip);
  }

  // Login via PIN — returns signed session token (24h TTL)
  app.post("/api/auth/login", async (req, res) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const rl = checkRateLimit(ip);
      if (rl.blocked) {
        return res.status(429).json({ success: false, message: `Demasiados intentos. Espera ${rl.remaining}s.`, retryAfter: rl.remaining });
      }

      const { pin } = req.body;
      if (!pin || typeof pin !== "string") {
        return res.status(400).json({ success: false, message: "PIN requerido" });
      }
      const promoter = await storage.getPromoterByPin(pin);
      if (!promoter) {
        recordFailedAttempt(ip);
        logAudit({ action: "LOGIN_FAILED", actor: "unknown", role: "unknown", ip, details: `PIN: ${pin.substring(0,2)}****` });
        const attEntry = loginAttempts.get(ip);
        const attLeft = MAX_ATTEMPTS - (attEntry?.count || 0);
        return res.status(401).json({ success: false, message: attLeft > 0 ? `PIN incorrecto. ${attLeft} intento(s) restante(s).` : `PIN incorrecto. Espera 30 segundos.` });
      }
      clearAttempts(ip);
      logAudit({ action: "LOGIN", actor: promoter.name, role: (promoter as any).role || "promotora", ip });
      const token = createSessionToken(promoter.id, promoter.name);
      return res.json({
        success: true,
        token,
        promoter: { id: promoter.id, name: promoter.name, role: (promoter as any).role || "promotora" },
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // Legacy PIN endpoint (backward compat)
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
      const token = createSessionToken(promoter.id, promoter.name);
      return res.json({
        success: true,
        token,
        promoter: { id: promoter.id, name: promoter.name, role: (promoter as any).role || "promotora" },
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
      // Default conTanque to true if not provided
      if (input.conTanque === undefined) input.conTanque = true;

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
        purchasePct: result.costoPctCmu, margin: result.margin,
        tirAnnual: result.tirBase, moic: result.moic,
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

  // ===== MARKET PRICES (Real-time from Kavak, MercadoLibre) =====
  // Price filter: $100,000–$500,000 MXN (eliminates guide/depreciation values)
  const PRICE_MIN = 100000;
  const PRICE_MAX = 500000;

  // Verified reference prices (Kavak/Seminuevos, March 2026)
  // Used when scraped data is unavailable or suspiciously low
  // Verified reference prices from Kavak.com (March 2026)
  // Key format: brand-model[-variant]-year (lowercase, spaces→dashes)
  const VERIFIED_PRICES: Record<string, { min: number; max: number; median: number }> = {
    // === CHEVROLET AVEO (LS/LT/LTZ) ===
    "chevrolet-aveo-2020": { min: 155000, max: 193000, median: 177000 },
    "chevrolet-aveo-2021": { min: 161000, max: 200000, median: 185000 },
    "chevrolet-aveo-ls-2021": { min: 157000, max: 192000, median: 181000 },
    "chevrolet-aveo-lt-2021": { min: 175000, max: 200000, median: 190000 },
    "chevrolet-aveo-2022": { min: 156000, max: 207000, median: 192000 },
    "chevrolet-aveo-ls-2022": { min: 156000, max: 200000, median: 186000 },
    "chevrolet-aveo-lt-2022": { min: 185000, max: 207000, median: 196000 },
    "chevrolet-aveo-2023": { min: 189000, max: 231000, median: 209000 },
    "chevrolet-aveo-ls-2023": { min: 189000, max: 218000, median: 203000 },
    "chevrolet-aveo-lt-2023": { min: 205000, max: 231000, median: 218000 },
    "chevrolet-aveo-2024": { min: 223000, max: 256000, median: 240000 },
    "chevrolet-aveo-lt-2024": { min: 235000, max: 256000, median: 246000 },
    "chevrolet-aveo-2025": { min: 250000, max: 285000, median: 268000 },
    // === NISSAN MARCH (Sense/Advance/Exclusive) ===
    "nissan-march-2020": { min: 165000, max: 215000, median: 190000 },
    "nissan-march-2021": { min: 168000, max: 223000, median: 197000 },
    "nissan-march-sense-2021": { min: 168000, max: 205000, median: 193000 },
    "nissan-march-advance-2021": { min: 210000, max: 223000, median: 215000 },
    "nissan-march-2022": { min: 194000, max: 246000, median: 215000 },
    "nissan-march-sense-2022": { min: 194000, max: 213000, median: 200000 },
    "nissan-march-advance-2022": { min: 215000, max: 246000, median: 225000 },
    "nissan-march-2023": { min: 194000, max: 312000, median: 230000 },
    "nissan-march-sense-2023": { min: 194000, max: 243000, median: 220000 },
    "nissan-march-advance-2023": { min: 214000, max: 240000, median: 227000 },
    "nissan-march-exclusive-2023": { min: 270000, max: 312000, median: 288000 },
    "nissan-march-2024": { min: 205000, max: 259000, median: 245000 },
    "nissan-march-sense-2024": { min: 205000, max: 225000, median: 215000 },
    "nissan-march-advance-2024": { min: 249000, max: 259000, median: 254000 },
    // === NISSAN V-DRIVE ===
    "nissan-v-drive-2020": { min: 182000, max: 210000, median: 193000 },
    "nissan-v-drive-2021": { min: 182000, max: 211000, median: 193000 },
    "nissan-v-drive-2022": { min: 189000, max: 215000, median: 200000 },
    "nissan-v-drive-2023": { min: 215000, max: 245000, median: 230000 },
    "nissan-v-drive-2024": { min: 240000, max: 270000, median: 255000 },
    "nissan-v-drive-2025": { min: 260000, max: 290000, median: 275000 },
    // === NISSAN VERSA (Sense/Advance/Platinum) ===
    "nissan-versa-2020": { min: 208000, max: 245000, median: 230000 },
    "nissan-versa-sense-2020": { min: 208000, max: 225000, median: 215000 },
    "nissan-versa-advance-2020": { min: 221000, max: 245000, median: 235000 },
    "nissan-versa-2021": { min: 220000, max: 259000, median: 240000 },
    "nissan-versa-sense-2021": { min: 220000, max: 237000, median: 227000 },
    "nissan-versa-advance-2021": { min: 245000, max: 259000, median: 252000 },
    "nissan-versa-2022": { min: 229000, max: 267000, median: 245000 },
    "nissan-versa-sense-2022": { min: 229000, max: 254000, median: 237000 },
    "nissan-versa-advance-2022": { min: 236000, max: 267000, median: 253000 },
    "nissan-versa-2023": { min: 252000, max: 290000, median: 275000 },
    "nissan-versa-sense-2023": { min: 252000, max: 270000, median: 262000 },
    "nissan-versa-advance-2023": { min: 265000, max: 290000, median: 278000 },
    "nissan-versa-2024": { min: 250000, max: 310000, median: 280000 },
    "nissan-versa-sense-2024": { min: 250000, max: 276000, median: 265000 },
    "nissan-versa-advance-2024": { min: 285000, max: 310000, median: 295000 },
    // === NISSAN SENTRA ===
    "nissan-sentra-2020": { min: 280000, max: 340000, median: 310000 },
    "nissan-sentra-2021": { min: 295000, max: 360000, median: 330000 },
    "nissan-sentra-2022": { min: 310000, max: 380000, median: 345000 },
    "nissan-sentra-2023": { min: 335000, max: 400000, median: 370000 },
    "nissan-sentra-2024": { min: 360000, max: 430000, median: 395000 },
    // === NISSAN KICKS ===
    "nissan-kicks-2021": { min: 295000, max: 350000, median: 320000 },
    "nissan-kicks-2022": { min: 310000, max: 370000, median: 340000 },
    "nissan-kicks-2023": { min: 335000, max: 395000, median: 365000 },
    "nissan-kicks-2024": { min: 365000, max: 420000, median: 395000 },
    // === CHEVROLET SPARK ===
    "chevrolet-spark-2020": { min: 145000, max: 180000, median: 165000 },
    "chevrolet-spark-2021": { min: 155000, max: 195000, median: 178000 },
    "chevrolet-spark-2022": { min: 165000, max: 205000, median: 188000 },
    "chevrolet-spark-2023": { min: 180000, max: 220000, median: 200000 },
    // === CHEVROLET CAVALIER ===
    "chevrolet-cavalier-2021": { min: 240000, max: 290000, median: 265000 },
    "chevrolet-cavalier-2022": { min: 255000, max: 310000, median: 280000 },
    "chevrolet-cavalier-2023": { min: 270000, max: 330000, median: 300000 },
    "chevrolet-cavalier-2024": { min: 290000, max: 350000, median: 320000 },
    // === CHEVROLET ONIX ===
    "chevrolet-onix-2021": { min: 235000, max: 280000, median: 258000 },
    "chevrolet-onix-2022": { min: 250000, max: 300000, median: 275000 },
    "chevrolet-onix-2023": { min: 265000, max: 320000, median: 292000 },
    "chevrolet-onix-2024": { min: 285000, max: 345000, median: 315000 },
    // === VOLKSWAGEN VENTO (Startline/Comfortline/Highline) ===
    "volkswagen-vento-2020": { min: 215000, max: 270000, median: 245000 },
    "volkswagen-vento-2021": { min: 225000, max: 285000, median: 255000 },
    "volkswagen-vento-startline-2021": { min: 225000, max: 260000, median: 242000 },
    "volkswagen-vento-comfortline-2021": { min: 250000, max: 285000, median: 268000 },
    "volkswagen-vento-2022": { min: 240000, max: 300000, median: 270000 },
    "volkswagen-vento-startline-2022": { min: 240000, max: 275000, median: 258000 },
    "volkswagen-vento-comfortline-2022": { min: 265000, max: 300000, median: 282000 },
    "volkswagen-vento-2023": { min: 260000, max: 320000, median: 290000 },
    "volkswagen-vento-2024": { min: 280000, max: 345000, median: 315000 },
    // === TOYOTA YARIS (Sedan) ===
    "toyota-yaris-2021": { min: 240000, max: 290000, median: 265000 },
    "toyota-yaris-sedan-2021": { min: 240000, max: 290000, median: 265000 },
    "toyota-yaris-2022": { min: 250000, max: 305000, median: 278000 },
    "toyota-yaris-sedan-2022": { min: 250000, max: 305000, median: 278000 },
    "toyota-yaris-2023": { min: 270000, max: 325000, median: 298000 },
    "toyota-yaris-sedan-2023": { min: 270000, max: 325000, median: 298000 },
    "toyota-yaris-2024": { min: 290000, max: 350000, median: 320000 },
    // === HYUNDAI GRAND I10 (GL/GLS) ===
    "hyundai-grand-i10-2021": { min: 195000, max: 240000, median: 218000 },
    "hyundai-grand-i10-gl-2021": { min: 195000, max: 225000, median: 210000 },
    "hyundai-grand-i10-gls-2021": { min: 215000, max: 240000, median: 228000 },
    "hyundai-grand-i10-2022": { min: 210000, max: 255000, median: 232000 },
    "hyundai-grand-i10-gl-2022": { min: 210000, max: 240000, median: 225000 },
    "hyundai-grand-i10-gls-2022": { min: 230000, max: 255000, median: 242000 },
    "hyundai-grand-i10-2023": { min: 225000, max: 270000, median: 248000 },
    "hyundai-grand-i10-2024": { min: 245000, max: 295000, median: 270000 },
    // === KIA RIO (LX/EX) ===
    "kia-rio-2021": { min: 245000, max: 295000, median: 270000 },
    "kia-rio-lx-2021": { min: 245000, max: 275000, median: 260000 },
    "kia-rio-2022": { min: 260000, max: 310000, median: 285000 },
    "kia-rio-lx-2022": { min: 260000, max: 290000, median: 275000 },
    "kia-rio-2023": { min: 275000, max: 330000, median: 303000 },
    "kia-rio-2024": { min: 295000, max: 355000, median: 325000 },
    // === RENAULT KWID ===
    "renault-kwid-2021": { min: 155000, max: 190000, median: 172000 },
    "renault-kwid-2022": { min: 165000, max: 200000, median: 182000 },
    "renault-kwid-2023": { min: 175000, max: 215000, median: 195000 },
    "renault-kwid-2024": { min: 190000, max: 235000, median: 212000 },
    "renault-kwid-2025": { min: 210000, max: 255000, median: 232000 },
    // === DODGE ATTITUDE ===
    "dodge-attitude-2021": { min: 180000, max: 220000, median: 200000 },
    "dodge-attitude-2022": { min: 190000, max: 235000, median: 212000 },
    "dodge-attitude-2023": { min: 205000, max: 250000, median: 228000 },
    "dodge-attitude-2024": { min: 225000, max: 270000, median: 248000 },
    // === SUZUKI SWIFT / DZIRE ===
    "suzuki-swift-2021": { min: 220000, max: 265000, median: 242000 },
    "suzuki-swift-2022": { min: 235000, max: 280000, median: 258000 },
    "suzuki-swift-2023": { min: 250000, max: 300000, median: 275000 },
    "suzuki-dzire-2021": { min: 195000, max: 235000, median: 215000 },
    "suzuki-dzire-2022": { min: 210000, max: 250000, median: 230000 },
    "suzuki-dzire-2023": { min: 225000, max: 265000, median: 245000 },
    // === VOLKSWAGEN GOL ===
    "volkswagen-gol-2020": { min: 175000, max: 210000, median: 192000 },
    "volkswagen-gol-2021": { min: 185000, max: 225000, median: 205000 },
    "volkswagen-gol-2022": { min: 195000, max: 240000, median: 218000 },
    // === BEAT (discontinued 2022) ===
    "chevrolet-beat-2020": { min: 140000, max: 175000, median: 158000 },
    "chevrolet-beat-2021": { min: 150000, max: 185000, median: 168000 },
    "chevrolet-beat-2022": { min: 160000, max: 195000, median: 178000 },
  };

  function getVerifiedKey(b: string, m: string, v: string | null | undefined, y: number): string {
    const base = `${b}-${m}`.toLowerCase().replace(/\s+/g, "-");
    const withVariant = v ? `${base}-${v}`.toLowerCase().replace(/\s+/g, "-") : null;
    // Try with variant first, then without
    if (withVariant && VERIFIED_PRICES[`${withVariant}-${y}`]) return `${withVariant}-${y}`;
    if (VERIFIED_PRICES[`${base}-${y}`]) return `${base}-${y}`;
    return "";
  }

  // Outlier filter: remove prices > 2 std dev from median
  function filterOutliers(pArr: number[]): number[] {
    if (pArr.length < 4) return pArr;
    const sorted = [...pArr].sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)];
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / sorted.length;
    const stdDev = Math.sqrt(variance);
    const lo = mid - 2 * stdDev;
    const hi = mid + 2 * stdDev;
    return sorted.filter(p => p >= lo && p <= hi);
  }

  app.post("/api/cmu/market-prices", async (req, res) => {
    try {
      const { brand, model, year, variant } = req.body;
      if (!brand || !model || !year) {
        return res.status(400).json({ message: "Se requiere brand, model, year" });
      }

      console.log(`[MarketPrices] Request: ${brand} ${model} ${year} (variant: ${variant || "any"})`);

      // === PRIORITY 0: Check DB cache (from client-side scraper) ===
      const cached = await getCachedPrice(brand, model, variant || null, parseInt(year));
      if (cached) {
        console.log(`[MarketPrices] Cache HIT: ${brand} ${model} ${year} — $${cached.min}-$${cached.max} (${cached.count} prices, scraped ${cached.scrapedAt})`);
        return res.json({
          brand, model, year, variant,
          prices: [], count: cached.count,
          min: cached.min, max: cached.max, median: cached.median, average: cached.average,
          p25: cached.p25 || null, p70: cached.p70 || null, p75: cached.p75 || null,
          avg_band: cached.avg_band || null, sourceCount: cached.sourceCount || 0,
          warnings: cached.warnings || [],
          sources: [{ name: "Cache (Kavak+MercadoLibre)", count: cached.count }],
          fallback: false,
          note: `Precios actualizados ${new Date(cached.scrapedAt).toLocaleDateString("es-MX")}`,
          timestamp: new Date().toISOString(),
        });
      }
      console.log(`[MarketPrices] Cache MISS — trying live sources + verified fallback`);

      const brandSlug = brand.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const modelSlug = model.toLowerCase().replace(/[- ]/g, "-").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const prices: { price: number; source: string; detail?: string }[] = [];
      const errors: string[] = [];
      const fetchHeaders = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
      };

      // Helper: extract all MXN prices from HTML text
      function extractPrices(html: string, source: string, minP = PRICE_MIN, maxP = PRICE_MAX) {
        const found: { price: number; source: string }[] = [];
        const regex = /\$\s*([\d]{1,3}(?:[,.]\d{3})+)/g;
        let m;
        while ((m = regex.exec(html)) !== null) {
          const p = parseInt(m[1].replace(/[,.]/g, ""));
          if (p >= minP && p <= maxP) {
            found.push({ price: p, source });
          }
        }
        return found;
      }

      // Helper: log HTML diagnostics
      function logHtml(source: string, url: string, status: number, html: string, priceCount: number) {
        const len = html.length;
        const preview = html.substring(0, 500).replace(/\n/g, " ").replace(/\s+/g, " ");
        const hasCaptcha = /captcha|challenge|cf-browser|recaptcha|hcaptcha|blocked/i.test(html.substring(0, 3000));
        const hasRedirect = /meta.*http-equiv.*refresh|window\.location/i.test(html.substring(0, 3000));
        console.log(`[MarketPrices][${source}] URL: ${url}`);
        console.log(`[MarketPrices][${source}] Status: ${status} | HTML length: ${len} | Captcha detected: ${hasCaptcha} | Redirect detected: ${hasRedirect} | Prices found: ${priceCount}`);
        console.log(`[MarketPrices][${source}] Preview: ${preview}`);
      }

      // === SOURCE 1: Kavak ===
      try {
        const kavakUrl = `https://www.kavak.com/mx/seminuevos/${brandSlug}/${modelSlug}/${year}`;
        const kavakRes = await fetch(kavakUrl, {
          headers: fetchHeaders,
          signal: AbortSignal.timeout(12000),
        });
        console.log(`[MarketPrices][Kavak] HTTP ${kavakRes.status} ${kavakRes.statusText}`);
        if (kavakRes.ok) {
          const html = await kavakRes.text();
          const beforeCount = prices.length;

          // Strategy A: "Precio desde" blocks
          const precioDesdeBlocks = html.match(/Precio\s*desde[\s\S]{0,200}?\$\s*[\d,.]+/gi) || [];
          for (const block of precioDesdeBlocks) {
            const pm = block.match(/\$\s*([\d]{1,3}(?:[,.]\d{3})+)/);
            if (pm) {
              const p = parseInt(pm[1].replace(/[,.]/g, ""));
              if (p >= PRICE_MIN && p <= PRICE_MAX) {
                prices.push({ price: p, source: "Kavak" });
              }
            }
          }

          // Strategy B: JSON-LD structured data
          const jsonLdMatches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi) || [];
          for (const jm of jsonLdMatches) {
            try {
              const inner = jm.replace(/<script[^>]*>/, "").replace(/<\/script>/i, "").trim();
              const parsed = JSON.parse(inner);
              const items = Array.isArray(parsed) ? parsed : [parsed];
              for (const item of items) {
                const offerPrice = item.offers?.price || item.offers?.lowPrice;
                if (offerPrice) {
                  const p = parseInt(String(offerPrice).replace(/[,.]/g, ""));
                  if (p >= PRICE_MIN && p <= PRICE_MAX) prices.push({ price: p, source: "Kavak" });
                }
                if (item.itemListElement) {
                  for (const li of item.itemListElement) {
                    const op = li.item?.offers?.price || li.item?.offers?.lowPrice;
                    if (op) {
                      const p = parseInt(String(op).replace(/[,.]/g, ""));
                      if (p >= PRICE_MIN && p <= PRICE_MAX) prices.push({ price: p, source: "Kavak" });
                    }
                  }
                }
              }
            } catch {}
          }

          // Strategy C: __NEXT_DATA__ JSON blob
          const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
          if (nextDataMatch) {
            try {
              const nd = JSON.parse(nextDataMatch[1]);
              const jsonStr = JSON.stringify(nd);
              const priceMatches = jsonStr.match(/"price"\s*:\s*(\d{5,6})/g) || [];
              for (const pm of priceMatches) {
                const val = parseInt(pm.replace(/"price"\s*:\s*/, ""));
                if (val >= PRICE_MIN && val <= PRICE_MAX) {
                  prices.push({ price: val, source: "Kavak" });
                }
              }
            } catch {}
          }

          // Strategy D: General price extraction fallback
          if (prices.filter(p => p.source === "Kavak").length === 0) {
            prices.push(...extractPrices(html, "Kavak"));
          }

          const kavakFound = prices.length - beforeCount;
          logHtml("Kavak", kavakUrl, kavakRes.status, html, kavakFound);
        } else {
          console.log(`[MarketPrices][Kavak] Non-OK response: ${kavakRes.status}`);
          errors.push(`Kavak: HTTP ${kavakRes.status}`);
        }
      } catch (err: any) {
        console.log(`[MarketPrices][Kavak] Fetch error: ${err.message}`);
        errors.push(`Kavak: ${err.message}`);
      }

      // === SOURCE 2: MercadoLibre API (OAuth2) ===
      try {
        const mlResult = await searchML(brand, model, parseInt(year));
        if (mlResult.prices.length > 0) {
          const beforeCount = prices.length;
          for (const p of mlResult.prices) {
            if (p.price >= PRICE_MIN && p.price <= PRICE_MAX) {
              prices.push({ price: p.price, source: "MercadoLibre" });
            }
          }
          console.log(`[MarketPrices][MercadoLibre API] Found ${prices.length - beforeCount} prices (year-filtered) from ${mlResult.total} total listings`);
        } else {
          console.log(`[MarketPrices][MercadoLibre API] No results${mlResult.error ? ': ' + mlResult.error : ''}`);
          if (mlResult.error) errors.push(`MercadoLibre: ${mlResult.error}`);
        }
      } catch (err: any) {
        console.log(`[MarketPrices][MercadoLibre API] Error: ${err.message}`);
        errors.push(`MercadoLibre: ${err.message}`);
      }

      // === SOURCE 3: Seminuevos.com (SSR HTML — works from server) ===
      try {
        // Use model-specific price range if we have a verified reference (avoids cross-model contamination)
        const snVKey = getVerifiedKey(brand, model, variant, parseInt(year));
        const snRef = snVKey ? VERIFIED_PRICES[snVKey] : null;
        const snMinPrice = snRef ? Math.round(snRef.median * 0.70) : 100000;
        const snMaxPrice = snRef ? Math.round(snRef.median * 1.45) : 350000;
        const snUrl = `https://www.seminuevos.com/autos?marca=${encodeURIComponent(brand.toLowerCase())}&modelo=${encodeURIComponent(model.toLowerCase())}&anio=${year}&precio-desde=${snMinPrice}&precio-hasta=${snMaxPrice}`;
        const snRes = await fetch(snUrl, {
          headers: fetchHeaders,
          signal: AbortSignal.timeout(12000),
        });
        console.log(`[MarketPrices][Seminuevos] HTTP ${snRes.status}`);
        if (snRes.ok) {
          const html = await snRes.text();
          const beforeCount = prices.length;
          // Extract $ prices from HTML — use dynamic range to avoid cross-model contamination
          const snPriceRegex = /\$\s*(\d{1,3}(?:,\d{3})+)/g;
          let snMatch;
          while ((snMatch = snPriceRegex.exec(html)) !== null) {
            const p = parseInt(snMatch[1].replace(/,/g, ""));
            if (p >= snMinPrice && p <= snMaxPrice) {
              prices.push({ price: p, source: "Seminuevos" });
            }
          }
          // Also extract from JSON-LD
          const snJsonLd = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi) || [];
          for (const jm of snJsonLd) {
            try {
              const inner = jm.replace(/<script[^>]*>/, "").replace(/<\/script>/i, "").trim();
              const parsed = JSON.parse(inner);
              const items = parsed.itemListElement || [];
              for (const item of items) {
                const op = item.item?.offers?.price;
                if (op) {
                  const p = typeof op === "number" ? op : parseInt(String(op).replace(/[,.]/g, ""));
                  if (p >= snMinPrice && p <= snMaxPrice) prices.push({ price: p, source: "Seminuevos" });
                }
              }
            } catch {}
          }
          const snFound = prices.length - beforeCount;
          console.log(`[MarketPrices][Seminuevos] Found ${snFound} prices`);
        } else {
          errors.push(`Seminuevos: HTTP ${snRes.status}`);
        }
      } catch (err: any) {
        console.log(`[MarketPrices][Seminuevos] Error: ${err.message}`);
        errors.push(`Seminuevos: ${err.message}`);
      }

      // === SOURCE 4: BBVA AutoMarket (GraphQL — works from server, no auth) ===
      try {
        const bbvaQuery = `query { products(filter: { name: { match: "${brand} ${model}" } }, pageSize: 20, sort: { price: ASC }) { total_count items { name price_range { minimum_price { final_price { value } } } } } }`;
        const bbvaRes = await fetch("https://automarket.bbva.mx/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": fetchHeaders["User-Agent"] },
          body: JSON.stringify({ query: bbvaQuery }),
          signal: AbortSignal.timeout(12000),
        });
        console.log(`[MarketPrices][BBVA] HTTP ${bbvaRes.status}`);
        if (bbvaRes.ok) {
          const bbvaData: any = await bbvaRes.json();
          const bbvaItems = bbvaData?.data?.products?.items || [];
          const bbvaTotal = bbvaData?.data?.products?.total_count || 0;
          const beforeCount = prices.length;
          const yearNum = parseInt(year);
          for (const item of bbvaItems) {
            const p = item?.price_range?.minimum_price?.final_price?.value;
            const itemName = (item?.name || "").toLowerCase();
            // STRICT: only exact year match in vehicle name
            if (p && p >= 80000 && p <= 400000 && itemName.includes(String(yearNum))) {
              prices.push({ price: Math.round(p), source: "BBVA AutoMarket" });
            }
          }
          const bbvaFound = prices.length - beforeCount;
          console.log(`[MarketPrices][BBVA] Found ${bbvaFound} prices (from ${bbvaTotal} total results)`);
        } else {
          errors.push(`BBVA: HTTP ${bbvaRes.status}`);
        }
      } catch (err: any) {
        console.log(`[MarketPrices][BBVA] Error: ${err.message}`);
        errors.push(`BBVA: ${err.message}`);
      }

      // Deduplicate, filter outliers, and calculate stats
      let rawUnique = [...new Set(prices.map(p => p.price))].sort((a, b) => a - b);
      console.log(`[MarketPrices] External sources found ${rawUnique.length} unique prices (raw): ${rawUnique.join(", ")}`);
      // Apply outlier filter
      const uniquePrices = filterOutliers(rawUnique);
      if (uniquePrices.length < rawUnique.length) {
        console.log(`[MarketPrices] After outlier filter: ${uniquePrices.length} prices: ${uniquePrices.join(", ")}`);
      }
      let count = uniquePrices.length;

      // Sanity check: if scraped average is suspiciously low OR high vs verified reference, use verified instead
      const vKey = getVerifiedKey(brand, model, variant, parseInt(year));
      if (count > 0 && vKey) {
        const avg = Math.round(uniquePrices.reduce((a, b) => a + b, 0) / count);
        const ref = VERIFIED_PRICES[vKey];
        if (avg < ref.median * 0.85 || avg > ref.median * 1.40) {
          console.log(`[MarketPrices] Sanity check FAILED: scraped avg $${avg} vs verified median $${ref.median} (ratio ${(avg/ref.median).toFixed(2)}). Using verified prices.`);
          prices.length = 0;
          prices.push({ price: ref.min, source: "Referencia verificada" });
          prices.push({ price: ref.median, source: "Referencia verificada" });
          prices.push({ price: ref.max, source: "Referencia verificada" });
          const vPrices = [ref.min, ref.median, ref.max];
          return res.json({
            brand, model, year, variant,
            prices: prices.slice(0, 50), count: 3,
            min: ref.min, max: ref.max, median: ref.median,
            average: Math.round((ref.min + ref.median + ref.max) / 3),
            sources: [{ name: "Referencia verificada (Kavak/Seminuevos)", count: 3 }],
            errors: errors.length > 0 ? errors : undefined,
            fallback: false,
            note: `Precios de mercado en vivo ajustados por referencia verificada (promedio scrapeado $${avg.toLocaleString()} vs mediana real $${ref.median.toLocaleString()})`,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // === FALLBACK: Use verified reference or catalog CMU data if external sources returned 0 ===
      let fallbackUsed = false;
      if (count === 0) {
        // Try verified reference first
        if (vKey) {
          const ref = VERIFIED_PRICES[vKey];
          console.log(`[MarketPrices] No external prices — using verified reference for ${vKey}`);
          return res.json({
            brand, model, year, variant,
            prices: [
              { price: ref.min, source: "Referencia verificada" },
              { price: ref.median, source: "Referencia verificada" },
              { price: ref.max, source: "Referencia verificada" },
            ],
            count: 3,
            min: ref.min, max: ref.max, median: ref.median,
            average: Math.round((ref.min + ref.median + ref.max) / 3),
            sources: [{ name: "Referencia verificada (Kavak/Seminuevos)", count: 3 }],
            errors: errors.length > 0 ? errors : undefined,
            fallback: false,
            note: "Precios de referencia verificada (Kavak/Seminuevos Mar 2026)",
            timestamp: new Date().toISOString(),
          });
        }
        console.log(`[MarketPrices] No external prices — falling back to catalog data`);
        try {
          const allModels = await storage.getModels();
          // Match by brand+model+year (case-insensitive)
          const matchingModels = allModels.filter((m: any) =>
            m.brand.toLowerCase() === brand.toLowerCase() &&
            m.model.toLowerCase() === model.toLowerCase() &&
            m.year === parseInt(year)
          );
          for (const m of matchingModels) {
            const cmuVal = m.cmu || m.cmuMedian;
            if (cmuVal && cmuVal > 0) {
              prices.push({ price: cmuVal, source: "Catálogo CMU", detail: m.variant || undefined });
            }
            if (m.cmuMin && m.cmuMin > 0) {
              prices.push({ price: m.cmuMin, source: "Catálogo CMU", detail: "mín" });
            }
            if (m.cmuMax && m.cmuMax > 0) {
              prices.push({ price: m.cmuMax, source: "Catálogo CMU", detail: "máx" });
            }
          }
          // If no specific match, try just brand+model (any year)
          if (prices.length === 0) {
            const fuzzyModels = allModels.filter((m: any) =>
              m.brand.toLowerCase() === brand.toLowerCase() &&
              m.model.toLowerCase() === model.toLowerCase()
            );
            for (const m of fuzzyModels) {
              const cmuVal = m.cmu || m.cmuMedian;
              if (cmuVal && cmuVal > 0) {
                prices.push({ price: cmuVal, source: "Catálogo CMU", detail: `${m.variant || ""} ${m.year}`.trim() });
              }
            }
          }
          fallbackUsed = prices.length > 0;
          console.log(`[MarketPrices] Catalog fallback: found ${prices.length} prices from ${matchingModels.length} models`);
        } catch (dbErr: any) {
          console.error(`[MarketPrices] Catalog fallback error:`, dbErr.message);
        }

        // Recalculate with fallback data
        const fbPrices = [...new Set(prices.map(p => p.price))].sort((a, b) => a - b);
        count = fbPrices.length;

        if (count === 0) {
          return res.json({
            brand, model, year, variant,
            prices: [], count: 0,
            min: null, max: null, median: null, average: null,
            sources: [], errors,
            fallback: false,
            message: "No se encontraron precios en fuentes de mercado ni en catálogo",
          });
        }

        const min = fbPrices[0];
        const max = fbPrices[count - 1];
        const median = count % 2 === 0
          ? Math.round((fbPrices[count / 2 - 1] + fbPrices[count / 2]) / 2)
          : fbPrices[Math.floor(count / 2)];
        const average = Math.round(fbPrices.reduce((a, b) => a + b, 0) / count);

        const sourceCounts: Record<string, number> = {};
        prices.forEach(p => { sourceCounts[p.source] = (sourceCounts[p.source] || 0) + 1; });

        return res.json({
          brand, model, year, variant,
          prices: prices.slice(0, 50),
          count,
          min, max, median, average,
          sources: Object.entries(sourceCounts).map(([name, n]) => ({ name, count: n })),
          errors: errors.length > 0 ? errors : undefined,
          fallback: true,
          message: "Precios obtenidos del catálogo CMU (fuentes externas no disponibles)",
          timestamp: new Date().toISOString(),
        });
      }

      const min = uniquePrices[0];
      const max = uniquePrices[count - 1];
      const median = count % 2 === 0
        ? Math.round((uniquePrices[count / 2 - 1] + uniquePrices[count / 2]) / 2)
        : uniquePrices[Math.floor(count / 2)];
      const average = Math.round(uniquePrices.reduce((a, b) => a + b, 0) / count);

      // Source breakdown
      const sourceCounts: Record<string, number> = {};
      prices.forEach(p => { sourceCounts[p.source] = (sourceCounts[p.source] || 0) + 1; });

      return res.json({
        brand, model, year, variant,
        prices: prices.slice(0, 50),
        count,
        min, max, median, average,
        sources: Object.entries(sourceCounts).map(([name, n]) => ({ name, count: n })),
        errors: errors.length > 0 ? errors : undefined,
        fallback: false,
        timestamp: new Date().toISOString(),
      });
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
      // Normalize camelCase → snake_case for all financial fields
      const b = req.body;
      const normalized: any = { ...b };
      const map: Record<string, string> = {
        precioAseguradora: "precio_aseguradora",
        reparacionEstimada: "reparacion_estimada",
        reparacionReal: "reparacion_real",
        conTanque: "con_tanque",
        margenEstimado: "margen_estimado",
        cmuValor: "cmu_valor",
        costoAdquisicion: "costo_adquisicion",
        costoReparacion: "costo_reparacion",
        kitGnvInstalado: "kit_gnv_instalado",
        kitGnvCosto: "kit_gnv_costo",
        kitGnvMarca: "kit_gnv_marca",
        kitGnvSerie: "kit_gnv_serie",
        tanqueTipo: "tanque_tipo",
        tanqueMarca: "tanque_marca",
        tanqueSerie: "tanque_serie",
        tanqueCosto: "tanque_costo",
        gnvModalidad: "gnv_modalidad",
        descuentoGnv: "descuento_gnv",
        numSerie: "num_serie",
        numMotor: "num_motor",
      };
      for (const [camel, snake] of Object.entries(map)) {
        if (b[camel] !== undefined && b[snake] === undefined) {
          normalized[snake] = b[camel];
        }
      }
      console.log(`[PATCH /api/vehicles/${id}] precio_aseg=${normalized.precio_aseguradora}, rep_real=${normalized.reparacion_real}, gnv_mod=${normalized.gnv_modalidad}, cmu=${normalized.cmu_valor}`);
      const updated = await storage.updateVehicle(id, normalized);
      if (!updated) return res.status(404).json({ message: "Vehículo no encontrado" });
      logAudit({ action: "VEHICLE_UPDATED", actor: "director", role: "director", target_type: "vehicle", target_id: String(id), details: JSON.stringify({ cmu: normalized.cmu_valor, status: normalized.status }) });
      return res.json(updated);
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/vehicles/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await storage.deleteVehicle(id);
      return res.json({ success: true, id });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // ===== CIERRE MENSUAL / COBRANZA (COB-01 to COB-05) =====

  // POST /api/cierre/ejecutar — Run monthly close (day 1 cron)
  app.post("/api/cierre/ejecutar", async (_req, res) => {
    try {
      const result = await ejecutarCierreMensual();
      const formatted = formatCierreResumenDirector(result);
      return res.json({ success: true, result, formatted });
    } catch (err: any) {
      console.error("[Cierre API] Error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  // POST /api/cierre/recordatorio3 — Day 3 reminder
  app.post("/api/cierre/recordatorio3", async (_req, res) => {
    try {
      const msgs = await recordatorioDia3();
      return res.json({ success: true, sent: msgs.length, msgs });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // POST /api/cierre/recordatorio5 — Day 5 last warning before FG
  app.post("/api/cierre/recordatorio5", async (_req, res) => {
    try {
      const msgs = await recordatorioDia5();
      return res.json({ success: true, sent: msgs.length, msgs });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // POST /api/cierre/fg — Apply FG for unpaid (day 6 cron)
  app.post("/api/cierre/fg", async (_req, res) => {
    try {
      const result = await aplicarFGDia6();
      const formatted = formatFGResumen(result);
      return res.json({ success: true, result, formatted });
    } catch (err: any) {
      console.error("[FG API] Error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  // POST /api/cierre/mora — Daily mora check
  app.post("/api/cierre/mora", async (_req, res) => {
    try {
      const result = await revisarMoraDiaria();
      const formatted = formatMoraResumen(result);
      return res.json({ success: true, result, formatted });
    } catch (err: any) {
      console.error("[Mora API] Error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  // POST /api/cierre/pago — Register payment (from Conekta webhook or manual)
  app.post("/api/cierre/pago", async (req, res) => {
    try {
      const { folio, mes, monto, metodo } = req.body;
      if (!folio || !mes || !monto) return res.status(400).json({ message: "folio, mes, monto required" });
      const result = await registrarPago(folio, mes, monto, metodo || "Manual");
      return res.json(result);
    } catch (err: any) {
      console.error("[Pago API] Error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  // GET /api/metrics/funnel — Conversion funnel drop-off metrics
  app.get("/api/metrics/funnel", async (_req, res) => {
    try {
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) return res.json({ steps: [], total: 0, period: "all_time" });
      const { neon } = await import("@neondatabase/serverless");
      const sql = neon(dbUrl);

      // Count total prospects (exclude test phones)
      const totalRows = await sql`
        SELECT COUNT(*) as c FROM conversation_states
        WHERE phone NOT LIKE '521999%'
      ` as any[];
      const total = parseInt(totalRows[0]?.c) || 0;

      if (total === 0) return res.json({ steps: [], total: 0, period: "all_time" });

      // Count how many reached each funnel stage via conversation_states
      // States that indicate "reached this step or beyond":
      const stateGroups = {
        registro: null, // total = all in conversation_states
        interes: [
          'prospect_select_model', 'prospect_tank', 'prospect_tank_question',
          'prospect_corrida', 'prospect_confirm', 'prospect_show_models',
          'prospect_post_corrida', 'prospect_awaiting_name', 'prospect_cold',
          'prospect_docs_capture', 'docs_capture', 'docs_pending',
          'interview_ready', 'interview_q1', 'interview_q2', 'interview_q3',
          'interview_q4', 'interview_q5', 'interview_q6', 'interview_q7',
          'interview_q8', 'interview_complete', 'completed',
        ],
        corrida: [
          'prospect_corrida', 'prospect_post_corrida', 'prospect_confirm',
          'prospect_tank_question', 'prospect_awaiting_name', 'prospect_cold',
          'prospect_docs_capture', 'docs_capture', 'docs_pending',
          'interview_ready', 'interview_q1', 'interview_q2', 'interview_q3',
          'interview_q4', 'interview_q5', 'interview_q6', 'interview_q7',
          'interview_q8', 'interview_complete', 'completed',
        ],
        folio: [
          'prospect_docs_capture', 'docs_capture', 'docs_pending',
          'interview_ready', 'interview_q1', 'interview_q2', 'interview_q3',
          'interview_q4', 'interview_q5', 'interview_q6', 'interview_q7',
          'interview_q8', 'interview_complete', 'completed',
        ],
        entrevista: [
          'interview_q1', 'interview_q2', 'interview_q3', 'interview_q4',
          'interview_q5', 'interview_q6', 'interview_q7', 'interview_q8',
          'interview_complete', 'completed',
        ],
        expediente: ['interview_complete', 'completed'],
      };

      // Single query: count per state
      const stateCounts = await sql`
        SELECT state, COUNT(*) as c FROM conversation_states
        WHERE phone NOT LIKE '521999%'
        GROUP BY state
      ` as any[];
      const countMap = new Map<string, number>();
      for (const row of stateCounts) {
        countMap.set(row.state, parseInt(row.c) || 0);
      }

      const sumStates = (states: string[]): number =>
        states.reduce((acc, s) => acc + (countMap.get(s) || 0), 0);

      // Docs-based steps: count from conversation_states context (same source as total)
      // context.docsCollected is an array of doc keys
      const allContexts = await sql`
        SELECT cs.context FROM conversation_states cs
        WHERE cs.phone NOT LIKE '521999%'
      ` as any[];
      let docsStartedCount = 0;
      let docsCompleteCount = 0;
      for (const row of allContexts) {
        const ctx = typeof row.context === 'string' ? JSON.parse(row.context) : (row.context || {});
        const docs = ctx.docsCollected || [];
        if (docs.length > 0) docsStartedCount++;
        if (docs.length >= 14) docsCompleteCount++;
      }

      const steps = [
        { name: "Registro", count: total },
        { name: "Interés", count: sumStates(stateGroups.interes) },
        { name: "Corrida", count: sumStates(stateGroups.corrida) },
        { name: "Folio creado", count: sumStates(stateGroups.folio) },
        { name: "Docs iniciados", count: docsStartedCount },
        { name: "Docs completos", count: docsCompleteCount },
        { name: "Entrevista", count: sumStates(stateGroups.entrevista) },
        { name: "Expediente completo", count: sumStates(stateGroups.expediente) },
      ];

      // Calculate pct and dropoff
      const result = steps.map((step, i) => ({
        name: step.name,
        count: step.count,
        pct: total > 0 ? Math.round((step.count / total) * 1000) / 10 : 0,
        dropoff: i === 0 ? 0 : steps[i - 1].count - step.count,
      }));

      res.json({ steps: result, total, period: "all_time" });
    } catch (e: any) {
      console.error("[Funnel] Error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/test/cross-check-unit — runs unit tests with MOCK documents
  app.post("/api/test/cross-check-unit", async (req, res) => {
    try {
      const { classifyAndValidateDoc, DOC_ORDER } = await import("./agent/vision");
      const fs = await import("fs");
      const path = await import("path");
      const FIXTURES = path.join(process.cwd(), "test/fixtures/cross-check");
      if (!fs.existsSync(FIXTURES)) return res.status(404).json({ error: "Mock fixtures not found" });
      const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, "expected.json"), "utf-8"));
      const results: any[] = [];
      for (const tc of expected.test_cases) {
        const imgPath = path.join(FIXTURES, tc.file);
        if (!fs.existsSync(imgPath)) { results.push({ file: tc.file, skipped: true }); continue; }
        const imgBase64 = fs.readFileSync(imgPath).toString("base64");
        let result: any;
        try { result = await classifyAndValidateDoc(imgBase64, tc.doc_type, DOC_ORDER, tc.existing_data || {}); }
        catch (e: any) { results.push({ file: tc.file, error: e.message }); continue; }
        const flags = result.cross_check_flags || [];
        const missingFlags = (tc.expected_flags || []).filter((f: string) => !flags.includes(f));
        const classOk = result.detected_type === tc.doc_type;
        results.push({ file: tc.file, doc_type: tc.doc_type, detected: result.detected_type, classification_ok: classOk, flags_got: flags, flags_expected: tc.expected_flags || [], missing_flags: missingFlags, pass: classOk && missingFlags.length === 0, extracted: result.extracted_data, notes: tc.notes });
      }
      const passed = results.filter(r => r.pass).length;
      const failed = results.filter(r => !r.pass && !r.skipped && !r.error).length;
      return res.json({ passed, failed, total: results.length, results });
    } catch (err: any) { return res.status(500).json({ error: err.message }); }
  });

  // POST /api/test/cross-check-e2e — runs regression tests server-side (temp, director only)
  app.post("/api/test/cross-check-e2e", async (req, res) => {
    try {
      const { classifyAndValidateDoc, DOC_ORDER } = await import("./agent/vision");
      const fs = await import("fs");
      const path = await import("path");

      const FIXTURES = path.join(process.cwd(), "test/fixtures/cross-check-real");
      if (!fs.existsSync(FIXTURES)) {
        return res.status(404).json({ error: "Fixtures not found — run from server with test/ directory" });
      }

      const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, "expected.json"), "utf-8"));
      const results: any[] = [];

      for (const tc of expected.test_cases) {
        const imgPath = path.join(FIXTURES, tc.file);
        if (!fs.existsSync(imgPath)) { results.push({ file: tc.file, skipped: true }); continue; }

        // Pass raw base64 WITHOUT data: prefix — classifyAndValidateDoc adds it internally
        const imgBase64 = fs.readFileSync(imgPath).toString("base64");
        const existingDataForTest = tc.existing_data || {};
        console.log(`[TestE2E] ${tc.doc_type} existingData keys: [${Object.keys(existingDataForTest).join(", ")}]`);
        let result: any;
        try {
          result = await classifyAndValidateDoc(imgBase64, tc.doc_type, DOC_ORDER, existingDataForTest);
        } catch (e: any) {
          results.push({ file: tc.file, error: e.message }); continue;
        }

        const flags = result.cross_check_flags || [];
        const expectedFlags = tc.expected_flags || [];
        const notFlags = tc.expected_flags_NOT || [];
        const missingFlags = expectedFlags.filter((f: string) => !flags.includes(f));
        const wrongFlags = notFlags.filter((f: string) => flags.includes(f));
        const classOk = result.detected_type === tc.doc_type;

        results.push({
          file: tc.file,
          doc_type: tc.doc_type,
          detected: result.detected_type,
          classification_ok: classOk,
          flags_got: flags,
          flags_expected: expectedFlags,
          missing_flags: missingFlags,
          wrong_flags: wrongFlags,
          pass: classOk && missingFlags.length === 0 && wrongFlags.length === 0,
          extracted: result.extracted_data,
          notes: tc.notes,
        });
      }

      const passed = results.filter(r => r.pass).length;
      const failed = results.filter(r => !r.pass && !r.skipped && !r.error).length;
      return res.json({ passed, failed, total: results.length, results });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/test/rag-roles — RAG answers across all 3 roles
  app.post("/api/test/rag-roles", async (_req, res) => {
    try {
      const { runRAGRolesTests } = await import("../test/rag-roles");
      const result = await runRAGRolesTests();
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/test/name-matcher — 67 name matching regression tests
  app.post("/api/test/name-matcher", async (_req, res) => {
    try {
      const mod = await import("../test/name-matcher");
      if (!mod.runNameMatcherTests) return res.status(500).json({ error: "runNameMatcherTests not found in module", keys: Object.keys(mod) });
      const result = mod.runNameMatcherTests();
      return res.json(result);
    } catch (err: any) {
      console.error("[Test] name-matcher import error:", err);
      return res.status(500).json({ error: err.message, stack: err.stack?.split("\n").slice(0, 5) });
    }
  });

  // POST /api/test/calibration-regression — TIR/MOIC calibration regression
  app.post("/api/test/calibration-regression", async (_req, res) => {
    try {
      const { runCalibrationRegression } = await import("../test/calibration-regression");
      const result = await runCalibrationRegression();
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/test/llm-ab-benchmark — gpt-4o-mini vs Claude Haiku A/B test
  app.post("/api/test/llm-ab-benchmark", async (_req, res) => {
    try {
      const { runLLMABBenchmark } = await import("../test/llm-ab-benchmark");
      const result = await runLLMABBenchmark();
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/test/vision-benchmark — GPT-4o vs Claude Sonnet head-to-head on 10 real documents
  app.post("/api/test/vision-benchmark", async (_req, res) => {
    try {
      const { runVisionBenchmark } = await import("../test/vision-benchmark");
      const result = await runVisionBenchmark();
      return res.json(result);
    } catch (err: any) {
      console.error("[VisionBenchmark]", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/market-prices/bulk-update — Daily bulk update of market prices for all catalog models
  app.post("/api/market-prices/bulk-update", async (_req, res) => {
    try {
      const { bulkUpdateMarketPrices } = await import("./market-bulk-update");
      const result = await bulkUpdateMarketPrices();
      const summary = result.results.map(r => ({
        model: `${r.brand} ${r.model} ${r.variant} ${r.year}`.trim(),
        count: r.count,
        min: r.min,
        median: r.median,
        max: r.max,
        sources: r.sources.map(s => `${s.name}(${s.count})`).join(", "),
      }));
      return res.json({
        updated: result.updated,
        skipped: result.skipped,
        errors: result.errors,
        models: summary,
        cmuUpdates: result.cmuUpdates || [],
      });
    } catch (err: any) {
      console.error("[BulkUpdate]", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/test/director-flow-suite — Director role flow tests (12 cases)
  app.post("/api/test/director-flow-suite", async (_req, res) => {
    try {
      const { runDirectorFlowSuite } = await import("../test/director-flow-suite");
      const summary = await runDirectorFlowSuite(storage, waAgent);
      return res.json(summary);
    } catch (err: any) {
      console.error("[DirectorFlowSuite]", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/test/client-flow-suite — Client role flow tests (10 cases)
  app.post("/api/test/client-flow-suite", async (_req, res) => {
    try {
      const { runClientFlowSuite } = await import("../test/client-flow-suite");
      const summary = await runClientFlowSuite(storage, waAgent);
      return res.json(summary);
    } catch (err: any) {
      console.error("[ClientFlowSuite]", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/test/flow-cpv-e2e — Full CPV origination flow simulation for documentation
  app.post("/api/test/flow-cpv-e2e", async (_req, res) => {
    try {
      const { runCPVFlowE2E } = await import("../test/flow-cpv-e2e");
      const result = await runCPVFlowE2E(storage, waAgent);
      return res.json(result);
    } catch (err: any) {
      console.error("[CPVFlowE2E]", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/test/full-flow-suite — Full promotora + prospecto flow suite (20 cases)
  app.post("/api/test/full-flow-suite", async (_req, res) => {
    try {
      const { runFullFlowSuite } = await import("../test/full-flow-suite");
      const summary = await runFullFlowSuite(storage, waAgent);
      return res.json(summary);
    } catch (err: any) {
      console.error("[FullFlowSuite]", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/test/bot-flow — Bot conversation flow regression tests (5 critical cases)
  app.post("/api/test/bot-flow", async (_req, res) => {
    try {
      const { runBotFlowTests } = await import("../test/bot-flow");
      const summary = await runBotFlowTests(storage);
      return res.json(summary);
    } catch (err: any) {
      console.error("[BotFlowTest]", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/originacion/reporte-pdf — Genera y envía PDF de folios a Ángeles
  app.post("/api/originacion/reporte-pdf", async (_req, res) => {
    try {
      const { generateWeeklyReportPDF, buildReportData } = await import("./report-generator");
      const { sendWeeklyReportEmail } = await import("./email-sender");

      const rows = await buildReportData();
      const pdfBuffer = await generateWeeklyReportPDF();

      const total = rows.length;
      const sinAvance = rows.filter(r => r.diasSinAvance >= 3).length;
      const completos = rows.filter(r => r.docsFaltantes.length === 0 && r.entrevistaCompleta).length;

      const result = await sendWeeklyReportEmail(pdfBuffer, undefined, { total, sinAvance, completos });
      if (!result.success) throw new Error(result.error || "Email send failed");

      return res.json({
        success: true,
        message: `Reporte enviado a mireles.ageles60@gmail.com`,
        stats: { total, sinAvance, completos },
        messageId: result.messageId,
      });
    } catch (err: any) {
      console.error("[ReportePDF]", err.message);
      return res.status(500).json({ message: err.message });
    }
  });

  // POST /api/cierre/reporte-semanal — Weekly cartera report (Wednesday cron)
  app.post("/api/cierre/reporte-semanal", async (_req, res) => {
    try {
      const report = await generarReporteSemanal();
      // Send to Josué via WhatsApp
      await fetch("https://cmu-originacion.fly.dev/api/whatsapp/send-outbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: JOSUE_PHONE, body: report }),
      }).catch(() => {});
      return res.json({ success: true, report });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // ===== CONEKTA WEBHOOK (COB-02) =====

  // POST /api/conekta/webhook AND /api/webhooks/conekta — Receives payment confirmations from Conekta
  // (Both paths supported: /api/conekta/webhook is internal, /api/webhooks/conekta is configured in Conekta panel)
  const conektaWebhookHandler = async (req: any, res: any) => {
    try {
      const event = await parseConektaWebhook(req.body);
      if (!event) {
        console.log("[Conekta Webhook] Unrecognized event");
        return res.json({ received: true });
      }

      console.log(`[Conekta Webhook] ${event.type} | folio=${event.folio} mes=${event.mes} | $${event.monto} via ${event.metodoPago}`);

      // Accept both order.paid (tarjeta) and charge.paid (SPEI/efectivo confirmed)
      const isPaidEvent = event.type === "order.paid" || event.type === "charge.paid";
      if (isPaidEvent && event.folio && event.mes > 0) {
        // Register the payment
        const result = await registrarPago(event.folio, event.mes, event.monto, event.metodoPago);
        console.log(`[Conekta Webhook] Payment registered: ${result.message}`);

        // Notify: taxista (confirmation) + director (always) + promotora (if was in mora)
        try {
          const { findCreditByFolio } = await import("./airtable-client");
          const credito: any = await findCreditByFolio(event.folio);
          const clienteNombre = credito?.Taxista || credito?.Cliente || "";
          const telefonoRaw = (credito?.Telefono || "").replace(/[^0-9]/g, "");
          const telefono = telefonoRaw.startsWith("52") ? telefonoRaw : `52${telefonoRaw}`;
          const enMora = (credito?.Estatus || "").toLowerCase().includes("mora") || (credito?.["Mora Dias"] || 0) > 0;

          const msgTaxista =
            `✅ Hola ${clienteNombre || ""}, recibimos tu pago de *$${event.monto.toLocaleString()}* por CMU vía ${event.metodoPago}.\n` +
            `Folio: ${event.folio} — Mes ${event.mes} cubierto.\n\nGracias.`;
          const msgDirector =
            `[Pago Conekta] ✅ *$${event.monto.toLocaleString()}* registrado\n` +
            `Folio: ${event.folio} — Mes ${event.mes}\n` +
            `Cliente: ${clienteNombre || "(no encontrado)"}\n` +
            `Método: ${event.metodoPago}\n` +
            `Registro: ${result.success ? "OK" : "FAIL — " + result.message}`;

          if (telefono && clienteNombre) {
            await sendWa(`whatsapp:+${telefono}`, msgTaxista).catch((e) =>
              console.error(`[Conekta Webhook] WA taxista falló: ${e.message}`),
            );
          }
          await sendWa(`whatsapp:+${JOSUE_PHONE}`, msgDirector).catch((e) =>
            console.error(`[Conekta Webhook] WA director falló: ${e.message}`),
          );
          if (enMora) {
            await sendWa(
              `whatsapp:+${ANGELES_PHONE}`,
              `[Cobranza] Cliente ${clienteNombre} (${event.folio}) salió de mora — pagó $${event.monto.toLocaleString()} mes ${event.mes}.`,
            ).catch((e) => console.error(`[Conekta Webhook] WA promotora falló: ${e.message}`));
          }
        } catch (e: any) {
          console.error(`[Conekta Webhook] Notificaciones fallaron: ${e.message}`);
        }
      }

      return res.json({ received: true, processed: event.type });
    } catch (err: any) {
      console.error("[Conekta Webhook] Error:", err.message);
      return res.json({ received: true, error: err.message }); // Always return 200 to Conekta
    }
  };
  app.post("/api/conekta/webhook", conektaWebhookHandler);
  app.post("/api/webhooks/conekta", conektaWebhookHandler);

  // POST /api/conekta/crear-liga — Create a payment link (internal use)
  app.post("/api/conekta/crear-liga", requireRole("director", "dev", "promotora"), async (req, res) => {
    try {
      const result = await crearLigaPago(req.body);
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/conekta/crear-liga-admin — PIN-gated link creation (no session required)
  app.post("/api/conekta/crear-liga-admin", async (req, res) => {
    try {
      const { pin, ...params } = req.body || {};
      if (pin !== "654321") return res.status(403).json({ message: "PIN incorrecto" });
      const result = await crearLigaPago(params);
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
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
      const { tipo, perfilTipo, taxista, taxistaId, folio: clientFolio, otpPhone } = req.body;
      
      if (!tipo) return res.status(400).json({ message: "Campo 'tipo' requerido" });
      if (!perfilTipo) return res.status(400).json({ message: "Campo 'perfilTipo' requerido" });

      const now = new Date().toISOString();
      let finalTaxistaId: number;

      // Accept BOTH formats:
      // Format A (frontend): { taxistaId, otpPhone, folio } — taxista already created client-side
      // Format B (API/WhatsApp): { taxista: { nombre, apellidoPaterno, telefono } } — create taxista
      if (taxistaId) {
        // Format A: taxista already exists
        finalTaxistaId = taxistaId;
      } else if (taxista?.nombre && taxista?.apellidoPaterno && taxista?.telefono) {
        // Format B: create taxista
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
        finalTaxistaId = newTaxista.id;
      } else {
        return res.status(400).json({ message: "Se requiere taxistaId o datos del taxista (nombre, apellidoPaterno, telefono)" });
      }

      // Generate folio with collision retry
      const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, "");
      const prefix = tipo === "validacion" ? "CMU-VAL" : tipo === "concesionario" ? "CMU-SIN" : "CMU-CPV";
      let folio: string;
      if (clientFolio) {
        // Client-provided folio: check if it already exists, append suffix if so
        const existing = await storage.getOriginationByFolio(clientFolio);
        if (existing) {
          const seq = await storage.getNextFolioSequence(prefix, dateStr);
          folio = `${prefix}-${dateStr}-${String(seq).padStart(3, "0")}`;
        } else {
          folio = clientFolio;
        }
      } else {
        const seq = await storage.getNextFolioSequence(prefix, dateStr);
        folio = `${prefix}-${dateStr}-${String(seq).padStart(3, "0")}`;
      }

      // Create origination
      const origination = await storage.createOrigination({
        folio,
        tipo,
        estado: "BORRADOR",
        taxistaId: finalTaxistaId,
        promoterId: 1,
        vehicleInventoryId: null,
        perfilTipo,
        currentStep: 1,
        datosIne: null, datosCsf: null, datosComprobante: null, datosConcesion: null,
        datosEstadoCuenta: null, datosHistorial: null, datosFactura: null, datosMembresia: null,
        otpCode: null, otpVerified: 0, otpPhone: otpPhone || taxista?.telefono || null,
        selfieUrl: null, vehiclePhotos: null,
        contractType: null, contractUrl: null, contractGeneratedAt: null,
        mifielDocumentId: null, mifielStatus: null,
        notes: null, rejectionReason: null,
        createdAt: now, updatedAt: now,
      });

      // Update taxista with folio
      await storage.updateTaxista(finalTaxistaId, { folio });

      logAudit({ action: "FOLIO_CREATED", actor: "promotora", role: "promotora", target_type: "folio", target_id: folio, details: `Tipo: ${tipo}, Perfil: ${perfilTipo}` });
      return res.json({ ...origination, taxistaId: finalTaxistaId });
    } catch (err: any) {
      console.error("Create origination error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/originations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;
      const updated = await storage.updateOrigination(id, updates);
      if (!updated) return res.status(404).json({ message: "Folio no encontrado" });
      if (updates.currentStep) logAudit({ action: "FOLIO_STEP_ADVANCED", actor: "system", role: "system", target_type: "folio", target_id: String(id), details: `Step: ${updates.currentStep}` });
      // When a vehicle is assigned to this origination, update vehicle status
      if (updates.vehicleInventoryId) {
        try {
          await storage.updateVehicle(updates.vehicleInventoryId, {
            status: "asignado",
            assignedOriginationId: id,
          } as any);
        } catch (e: any) {
          console.error("[routes] Failed to update vehicle status:", e.message);
        }
      }
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

  // ===== OTP (Twilio Verify — real when credentials present, simulated otherwise) =====
  const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID;
  const twilioEnabled = !!(TWILIO_SID && TWILIO_TOKEN);
  const verifyEnabled = !!(twilioEnabled && TWILIO_VERIFY_SID);
  if (verifyEnabled) console.log("[Twilio] Verify enabled with SID:", TWILIO_VERIFY_SID?.slice(0, 8) + "...");
  else if (twilioEnabled) console.warn("[Twilio] WhatsApp OK but Verify NOT configured — set TWILIO_VERIFY_SID");
  else console.log("[Twilio] No credentials — OTP will be simulated");

  app.post("/api/originations/:id/otp/send", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { phone } = req.body;
      const orig = await storage.getOrigination(id).catch(() => null);
      const phoneNumber = phone || orig?.otpPhone || "";
      if (!phoneNumber) return res.status(400).json({ success: false, message: "Teléfono requerido" });

      const clean = phoneNumber.replace(/\D/g, "");
      const e164 = phoneNumber.startsWith("+") ? phoneNumber : `+52${clean}`;

      if (verifyEnabled) {
        const twilioRes = await fetch(`https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SID}/Verifications`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
          },
          body: `To=${encodeURIComponent(e164)}&Channel=sms`,
        });
        const data = await twilioRes.json();
        if (data.status === "pending") {
          await storage.updateOrigination(id, { otpPhone: phoneNumber } as any).catch(() => {});
          return res.json({ success: true, status: "pending", message: "SMS enviado vía Twilio Verify" });
        }
        // Twilio failed (trial restrictions, etc.) — fall through to simulation
        console.warn("[Twilio] Send failed:", data.message || data.code);
      }

      // No Verify configured — fail clearly
      return res.status(503).json({ success: false, message: "Servicio OTP no configurado. Se requiere TWILIO_VERIFY_SID." });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/originations/:id/otp/verify", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { code, phone } = req.body;
      if (!code || code.length !== 6) return res.status(400).json({ verified: false, message: "Código de 6 dígitos requerido" });

      const orig = await storage.getOrigination(id).catch(() => null);
      const phoneNumber = phone || orig?.otpPhone || "";
      const e164 = phoneNumber.startsWith("+") ? phoneNumber : `+52${phoneNumber.replace(/\D/g, "")}`;

      if (verifyEnabled && phoneNumber) {
        const twilioRes = await fetch(`https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SID}/VerificationChecks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
          },
          body: `To=${encodeURIComponent(e164)}&Code=${code}`,
        });
        const data = await twilioRes.json();
        if (data.status === "approved") {
          if (orig) await storage.updateOrigination(id, { otpVerified: 1 } as any);
          return res.json({ verified: true, message: "Verificado vía Twilio" });
        }
        return res.json({ verified: false, message: data.message || "Código incorrecto o expirado" });
      }

      // No Verify configured — fail clearly
      return res.status(503).json({ verified: false, message: "Servicio OTP no configurado. Se requiere TWILIO_VERIFY_SID." });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // ===== MIFIEL (Firma Electrónica — real when credentials present) =====
  // ===== CONVERSATION STATE (shared between WhatsApp + PWA) =====
  app.get("/api/conversation-state/:phone", async (req, res) => {
    try {
      const { neon } = await import("@neondatabase/serverless");
      const sqlCS = neon(process.env.DATABASE_URL!);
      const phone = req.params.phone.replace(/\D/g, "");
      const rows = await sqlCS`SELECT phone, state, context FROM conversation_states WHERE phone = ${phone}` as any[];
      if (!rows.length) return res.json({ state: null, context: {} });
      const ctx = typeof rows[0].context === 'string' ? JSON.parse(rows[0].context) : rows[0].context;
      res.json({ state: rows[0].state, context: ctx });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/conversation-state/:phone", async (req, res) => {
    try {
      const { neon } = await import("@neondatabase/serverless");
      const sqlCS = neon(process.env.DATABASE_URL!);
      const phone = req.params.phone.replace(/\D/g, "");
      const { state, context } = req.body;
      await sqlCS`
        INSERT INTO conversation_states (phone, state, context, updated_at)
        VALUES (${phone}, ${state || 'idle'}, ${JSON.stringify(context || {})}, NOW())
        ON CONFLICT (phone) DO UPDATE SET state = ${state || 'idle'}, context = ${JSON.stringify(context || {})}, updated_at = NOW()
      `;
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ===== INVENTORY (for PWA prospect flow) =====
  app.get("/api/inventory", async (req, res) => {
    try {
      const { neon } = await import("@neondatabase/serverless");
      const sqlInv = neon(process.env.DATABASE_URL!);
      const inv = await sqlInv`SELECT id, marca as brand, modelo as model, variante as variant, anio as year, cmu_valor as cmu, status FROM vehicles_inventory WHERE status = 'disponible' ORDER BY marca, modelo, anio` as any[];
      res.json(inv);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  const MIFIEL_APP_ID = process.env.MIFIEL_APP_ID;
  const MIFIEL_APP_SECRET = process.env.MIFIEL_APP_SECRET;
  const MIFIEL_BASE = process.env.MIFIEL_BASE_URL || "https://app-sandbox.mifiel.com/api/v1";
  const mifielEnabled = !!(MIFIEL_APP_ID && MIFIEL_APP_SECRET);
  if (mifielEnabled) console.log("[Mifiel] Enabled (sandbox)");
  else console.log("[Mifiel] No credentials — firma will be simulated");

  app.post("/api/mifiel/send", requireRole("director", "dev"), async (req, res) => {
    try {
      const { originationId, pdfBase64, signerName, signerEmail, signerPhone } = req.body;
      if (!originationId) return res.status(400).json({ message: "originationId requerido" });

      if (mifielEnabled && pdfBase64) {
        // Real Mifiel: create document with signers
        const mifielAuth = Buffer.from(`${MIFIEL_APP_ID}:${MIFIEL_APP_SECRET}`).toString("base64");

        // Create document via Mifiel API
        const formData = new URLSearchParams();
        formData.append("file_base64", pdfBase64);
        formData.append("signatories[0][name]", signerName || "Operador");
        formData.append("signatories[0][email]", signerEmail || "operador@cmu.mx");
        formData.append("signatories[0][tax_id]", ""); // FESCV doesn't require RFC
        if (signerPhone) formData.append("signatories[0][phone]", signerPhone);
        formData.append("send_invites", "true");
        formData.append("signatories[0][allowed_signature_methods]", "FESCV");

        const mifielRes = await fetch(`${MIFIEL_BASE}/documents`, {
          method: "POST",
          headers: {
            "Authorization": `Basic ${mifielAuth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData.toString(),
        });

        const mifielData = await mifielRes.json();

        if (mifielData.id) {
          const docId = mifielData.id;
          const widgetId = mifielData.widget_id || null;
          
          // Build signing URL for the first signatory
          const signers = mifielData.signatories || [];
          const signerWidget = signers[0]?.widget_id || widgetId;
          const signingUrl = signerWidget 
            ? `${MIFIEL_BASE.replace('/api/v1', '')}/sign/${signerWidget}`
            : null;
          
          await storage.updateOrigination(originationId, {
            mifielDocumentId: docId,
            mifielStatus: "pending",
          } as any).catch(() => {});

          // Send signing link via WhatsApp to taxista
          if (signingUrl && signerPhone) {
            const waMsg = `*Firma de contrato CMU*\n\nPara firmar tu contrato necesitas:\n1. Tu INE (frente y reverso)\n2. Una selfie (prueba de vida)\n\nAbre este link y sigue las instrucciones:\n${signingUrl}\n\nNo necesitas e.firma ni archivos especiales.`;
            fetch("http://localhost:5000/api/whatsapp/send-outbound", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ to: signerPhone, body: waMsg }),
            }).catch(e => console.error("[Mifiel] WA send error:", e.message));
            console.log(`[Mifiel] Signing link sent to ${signerPhone}: ${signingUrl}`);
          }

          // Notify director
          fetch("http://localhost:5000/api/whatsapp/send-outbound", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: JOSUE_PHONE, body: `[Mifiel] Contrato enviado para firma.\nFolio: ${originationId}\nFirmante: ${signerName}\n${signingUrl ? `Link: ${signingUrl}` : ""}` }),
          }).catch(() => {});

          // Send PAG as second document if compraventa
          let pagDocId: string | null = null;
          let pagSigningUrl: string | null = null;
          if (pagPdfBase64) {
            try {
              const pagFormData = new URLSearchParams();
              pagFormData.append("file_base64", pagPdfBase64);
              pagFormData.append("signatories[0][name]", signerName || "Operador");
              pagFormData.append("signatories[0][email]", signerEmail || "operador@cmu.mx");
              pagFormData.append("signatories[0][tax_id]", "");
              if (signerPhone) pagFormData.append("signatories[0][phone]", signerPhone);
              pagFormData.append("send_invites", "true");
              pagFormData.append("signatories[0][allowed_signature_methods]", "FESCV");
              const pagRes = await fetch(`${MIFIEL_BASE}/documents`, {
                method: "POST",
                headers: { "Authorization": `Basic ${mifielAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
                body: pagFormData.toString(),
              });
              const pagData = await pagRes.json();
              if (pagData.id) {
                pagDocId = pagData.id;
                const pagWidget = pagData.signatories?.[0]?.widget_id || pagData.widget_id;
                pagSigningUrl = pagWidget ? `${MIFIEL_BASE.replace('/api/v1', '')}/sign/${pagWidget}` : null;
                console.log(`[Mifiel] PAG sent, docId=${pagDocId}`);
              }
            } catch (e: any) {
              console.error("[Mifiel] PAG send failed:", e.message);
            }
          }

          return res.json({
            success: true,
            documentId: docId,
            widgetId,
            signingUrl,
            pagDocumentId: pagDocId,
            pagSigningUrl,
            status: "pending",
            message: "Contrato" + (pagDocId ? " + Pagaré" : "") + " enviado para firma" + (signingUrl ? " — link enviado por WhatsApp" : ""),
          });
        } else {
          console.error("[Mifiel] Create failed:", mifielData);
          // Fall through to simulation
        }
      }

      // Simulation fallback
      const simDocId = `mfl-sim-${Date.now()}`;
      await storage.updateOrigination(originationId, {
        mifielDocumentId: simDocId,
        mifielStatus: "pending",
      } as any).catch(() => {});
      console.warn("[Mifiel] SIMULATED — no credentials. Set MIFIEL_APP_ID + MIFIEL_APP_SECRET for real firma.");
      return res.json({ success: true, documentId: simDocId, simulated: true, status: "pending", message: "⚠️ Firma SIMULADA — sin credenciales Mifiel. No tiene validez legal." });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/mifiel/status/:docId", async (req, res) => {
    try {
      const { docId } = req.params;

      if (mifielEnabled && !docId.startsWith("mfl-sim-")) {
        const mifielAuth = Buffer.from(`${MIFIEL_APP_ID}:${MIFIEL_APP_SECRET}`).toString("base64");
        const mifielRes = await fetch(`${MIFIEL_BASE}/documents/${docId}`, {
          headers: { "Authorization": `Basic ${mifielAuth}` },
        });
        const data = await mifielRes.json();
        return res.json({
          documentId: docId,
          status: data.status, // "pending", "signed", etc.
          signedAt: data.signed_at || null,
          signatories: data.signatories || [],
        });
      }

      // Simulation
      return res.json({ documentId: docId, status: "pending", simulated: true });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // Webhook for Mifiel callbacks
  app.post("/api/mifiel/webhook", async (req, res) => {
    try {
      const { document_id, status, callback_type } = req.body;
      console.log(`[Mifiel Webhook] doc=${document_id} status=${status} type=${callback_type}`);

      if (status === "signed" || callback_type === "document_closed") {
        // Find origination by mifiel document ID and update status
        const origs = await storage.listOriginations();
        const orig = origs.find((o: any) => (o.mifielDocumentId || o.mifiel_document_id) === document_id);
        if (orig) {
          await storage.updateOrigination(orig.id, {
            mifielStatus: "signed",
            estado: "FIRMADO",
          } as any);
          console.log(`[Mifiel Webhook] Origination ${orig.id} marked as FIRMADO`);

          // Consolidated post-firma notification (taxista + director + promotora)
          try {
            const taxista = orig.taxistaId ? await storage.getTaxista(orig.taxistaId) : null;
            const vehicle = orig.vehicleInventoryId ? await storage.getVehicle(orig.vehicleInventoryId) : null;
            const nombre = taxista ? `${taxista.nombre} ${taxista.apellidoPaterno || ""}`.trim() : ((orig as any).taxistaNombre || "");
            const telefono = taxista?.telefono || (orig as any).otpPhone || (orig as any).taxistaTelefono || "";
            let cuotaMensual = 0;
            let precioTotal = 0;
            try {
              const meta = orig.notes ? JSON.parse(orig.notes) : null;
              if (meta?.cuota) cuotaMensual = Number(meta.cuota);
              if (meta?.pv) precioTotal = Number(meta.pv);
            } catch { /* nada */ }
            const { notificarPostFirma } = await import("./conductor-proactivo-engine");
            const sendWaForNotify = async (to: string, body: string) => { await sendWa(to, body); };
            await notificarPostFirma({
              folio: orig.folio,
              nombreTaxista: nombre,
              telefonoTaxista: telefono,
              marca: vehicle?.marca,
              modelo: vehicle?.modelo,
              anio: vehicle?.anio,
              cuotaMensual,
              precioTotal,
              fechaFirma: orig.contractGeneratedAt || new Date().toISOString(),
            }, sendWaForNotify, JOSUE_PHONE, ANGELES_PHONE);
          } catch (e: any) {
            console.error(`[Mifiel Webhook] notificarPostFirma falló: ${e.message}`);
          }
        }
      }

      return res.json({ received: true });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // ===== CONEKTA (Pagos — anticipo y mensualidades) =====
  const CONEKTA_PRIVATE_KEY = process.env.CONEKTA_PRIVATE_KEY;
  const CONEKTA_PUBLIC_KEY = process.env.CONEKTA_PUBLIC_KEY;
  const conektaEnabled = !!CONEKTA_PRIVATE_KEY;
  if (conektaEnabled) console.log("[Conekta] Enabled (production)");
  else console.log("[Conekta] No credentials — pagos will be placeholder");

  app.post("/api/payments/create-order", async (req, res) => {
    try {
      const { originationId, amount, concept, customerName, customerEmail, customerPhone } = req.body;
      if (!amount || !concept) return res.status(400).json({ message: "amount y concept requeridos" });

      if (conektaEnabled) {
        // Real Conekta: create order
        const conektaRes = await fetch("https://api.conekta.io/orders", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/vnd.conekta-v2.2.0+json",
            "Authorization": "Basic " + Buffer.from(`${CONEKTA_PRIVATE_KEY}:`).toString("base64"),
          },
          body: JSON.stringify({
            currency: "MXN",
            customer_info: {
              name: customerName || "Operador CMU",
              email: customerEmail || "operador@cmu.mx",
              phone: customerPhone || "+524491234567",
            },
            line_items: [{
              name: concept,
              unit_price: amount * 100, // Conekta uses centavos
              quantity: 1,
            }],
            charges: [{
              payment_method: { type: "default" }, // Allows all methods
            }],
            metadata: {
              origination_id: String(originationId || ""),
            },
          }),
        });

        const data = await conektaRes.json();
        if (data.id) {
          return res.json({
            success: true,
            orderId: data.id,
            checkoutUrl: data.checkout?.url || null,
            status: data.payment_status,
            message: "Orden creada en Conekta",
          });
        } else {
          console.error("[Conekta] Error:", data);
        }
      }

      // Simulation — Conekta is actually configured (crear-liga works), this path is for other payment methods
      console.warn("[Conekta] Simulation path reached — check CONEKTA_PRIVATE_KEY");
      return res.json({
        success: true,
        orderId: `ord-sim-${Date.now()}`,
        simulated: true,
        status: "pending",
        message: "⚠️ Pago SIMULADO — use /api/conekta/crear-liga para pagos reales.",
      });
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
      const isValidacion = orig.tipo === "validacion";
      const contractType = isValidacion ? "convenio_validacion" : "contrato_compraventa";

      // Get taxista, vehicle and promoter data
      const taxista = orig.taxistaId ? await storage.getTaxista(orig.taxistaId) : null;
      const vehicle = orig.vehicleInventoryId ? await storage.getVehicle(orig.vehicleInventoryId) : null;
      const promoterRec = orig.promoterId ? await storage.getPromoterById(orig.promoterId) : null;
      const promoter = promoterRec ? { name: promoterRec.name, folio: `PR-${String(promoterRec.id).padStart(3, '0')}` } : null;

      // Generate primary PDF (TSR for compraventa, VAL for validacion)
      const pdfBuffer = isValidacion
        ? await generateConvenioValidacion(orig, taxista, vehicle, promoter)
        : await generateContratoCompraventa(orig, taxista, vehicle, promoter);

      // For compraventa: ALSO generate PAG (Pagaré de Anticipo)
      let pagPdfBuffer: Buffer | null = null;
      let pagContract: any = null;
      if (!isValidacion) {
        try {
          const pagDocx = await contractEngine.generatePAG(orig, taxista, vehicle);
          pagPdfBuffer = await contractEngine.docxToPdf(pagDocx);
        } catch (e: any) {
          console.error("[PAG] Generation failed:", e.message);
        }
      }

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

      // Persist PAG if generated
      if (pagPdfBuffer) {
        try {
          pagContract = await storage.createContract({
            originationId: id,
            tipo: "pagare_anticipo",
            folio: orig.folio?.replace("SIN", "PAG")?.replace("CPV", "PAG") || orig.folio,
            contractData: JSON.stringify({ ...contractData, tipo: "pagare_anticipo", parent: contract.id }),
            pdfUrl: `/api/originations/${id}/contract/pdf?type=PAG`,
            pdfGeneratedAt: now,
            status: "generated",
            createdAt: now,
            mifielDocumentId: null,
            signedAt: null,
            signedByTaxista: 0,
            signedByPromotora: 0,
            signedByCmu: 0,
          });
          pdfCache.set(id * 1000 + 1, { buffer: pagPdfBuffer, folio: pagContract.folio, type: "pagare_anticipo" });
        } catch (e: any) {
          console.error("[PAG] Save failed:", e.message);
        }
      }

      // Update origination
      await storage.updateOrigination(id, {
        contractType,
        contractUrl: contract.pdfUrl,
        contractGeneratedAt: now,
        estado: "GENERADO",
      } as any);

      return res.json({
        contract,
        pagContract,
        message: isValidacion ? "Convenio generado" : `Contrato${pagPdfBuffer ? " + Pagar\u00e9" : ""} generado`,
        pdfSize: pdfBuffer.length,
        pagPdfSize: pagPdfBuffer?.length || 0,
      });
    } catch (err: any) {
      console.error("Contract generation error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  // Download contract PDF
  // ===== CONTRACT ENGINE v10 — DOCX Template Generation =====
  app.post("/api/originations/:id/contract/v10", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { templateType, outputFormat } = req.body; // templateType: TSR, PAG, CER, CTK, REST, RES, LIQ, ADD-PRO, VAL
      if (!templateType || !contractEngine.getAvailableTemplates().includes(templateType)) {
        return res.status(400).json({ message: `Template inválido. Disponibles: ${contractEngine.getAvailableTemplates().join(", ")}` });
      }

      const orig = await storage.getOrigination(id);
      if (!orig) return res.status(404).json({ message: "Folio no encontrado" });
      const taxista = (orig as any).taxistaId ? await storage.getTaxista((orig as any).taxistaId) : null;
      const vehicle = (orig as any).vehicleInventoryId ? await storage.getVehicle((orig as any).vehicleInventoryId) : null;

      // Query aval and kit_gnv from Neon
      const { neon } = require("@neondatabase/serverless");
      const sql = neon(process.env.DATABASE_URL);
      const avales = await sql`SELECT * FROM avales WHERE origination_id = ${id} LIMIT 1`;
      const aval = avales.length > 0 ? avales[0] : null;
      const kits = await sql`SELECT * FROM kit_gnv WHERE origination_id = ${id} LIMIT 1`;
      const kitGnv = kits.length > 0 ? kits[0] : null;

      // Query Airtable credit data for REST/RES/LIQ
      let credito: any = null;
      if (["REST", "RES", "LIQ"].includes(templateType)) {
        try {
          const { findCreditByFolio } = require("./airtable-client");
          credito = await findCreditByFolio(orig.folio);
        } catch (e: any) { console.error("Airtable credit query error:", e.message); }
      }

      // Generate the DOCX
      let docxBuffer: Buffer;
      switch (templateType) {
        case "TSR": docxBuffer = await contractEngine.generateTSR(orig, taxista, vehicle, aval, kitGnv); break;
        case "PAG": docxBuffer = await contractEngine.generatePAG(orig, taxista, vehicle); break;
        case "CER": docxBuffer = await contractEngine.generateCER(orig, taxista, vehicle, kitGnv); break;
        case "CTK": docxBuffer = await contractEngine.generateCTK(orig, taxista, kitGnv); break;
        case "REST": docxBuffer = await contractEngine.generateREST(orig, taxista, aval, credito); break;
        case "RES": docxBuffer = await contractEngine.generateRES(orig, taxista, vehicle, credito); break;
        case "LIQ": docxBuffer = await contractEngine.generateLIQ(orig, taxista, vehicle, credito); break;
        case "ADD-PRO": docxBuffer = await contractEngine.generateADDPRO(orig, taxista); break;
        case "VAL": docxBuffer = await contractEngine.generateVAL(orig, taxista); break;
        default: return res.status(400).json({ message: "Template no soportado" });
      }

      // Convert to PDF if requested
      if (outputFormat === "pdf") {
        const pdfBuffer = await contractEngine.docxToPdf(docxBuffer);
        const filename = `${orig.folio}-${templateType}.pdf`;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
        return res.send(pdfBuffer);
      }

      // Return DOCX by default
      const filename = `${orig.folio}-${templateType}.docx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.send(docxBuffer);
    } catch (err: any) {
      console.error("Contract v10 generation error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  // Legacy PDF endpoint (contract-pdf.ts / pdfkit)
  app.get("/api/originations/:id/contract/pdf", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const requestedType = (req.query.type as string || "").toUpperCase();

      // Serve PAG if requested
      if (requestedType === "PAG") {
        const pagCached = pdfCache.get(id * 1000 + 1);
        if (pagCached) {
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", `inline; filename="${pagCached.folio}-pagare.pdf"`);
          res.setHeader("Content-Length", pagCached.buffer.length);
          return res.send(pagCached.buffer);
        }
        // Regenerate PAG on the fly
        const orig = await storage.getOrigination(id);
        if (!orig) return res.status(404).json({ message: "Folio no encontrado" });
        const taxista = orig.taxistaId ? await storage.getTaxista(orig.taxistaId) : null;
        const vehicle = orig.vehicleInventoryId ? await storage.getVehicle(orig.vehicleInventoryId) : null;
        const pagDocx = await contractEngine.generatePAG(orig, taxista, vehicle);
        const pagPdf = await contractEngine.docxToPdf(pagDocx);
        pdfCache.set(id * 1000 + 1, { buffer: pagPdf, folio: orig.folio, type: "pagare_anticipo" });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${orig.folio}-pagare.pdf"`);
        res.setHeader("Content-Length", pagPdf.length);
        return res.send(pagPdf);
      }

      // Check cache first
      let cached = pdfCache.get(id);
      
      if (!cached) {
        // Regenerate PDF on the fly
        const orig = await storage.getOrigination(id);
        if (!orig) return res.status(404).json({ message: "Folio no encontrado" });

        const taxista = orig.taxistaId ? await storage.getTaxista(orig.taxistaId) : null;
        const vehicle = orig.vehicleInventoryId ? await storage.getVehicle(orig.vehicleInventoryId) : null;
        const promoterRec = orig.promoterId ? await storage.getPromoterById(orig.promoterId) : null;
        const promoter = promoterRec ? { name: promoterRec.name, folio: `PR-${String(promoterRec.id).padStart(3, '0')}` } : null;
        const contractType = orig.tipo === "validacion" ? "convenio_validacion" : "contrato_compraventa";

        const pdfBuffer = contractType === "convenio_validacion"
          ? await generateConvenioValidacion(orig, taxista, vehicle, promoter)
          : await generateContratoCompraventa(orig, taxista, vehicle, promoter);

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

  // ===== CONVERSATION STATE API (for PWA to sync with WhatsApp Agent) =====

  // GET /api/conversation-state/:phone — Read current state and context
  app.get("/api/conversation-state/:phone", async (req, res) => {
    try {
      const { phone } = req.params;
      // Normalize phone (remove country code if present)
      const normalizedPhone = phone.replace(/^\+?52/, "").replace(/\D/g, "");

      const session = await getSession(normalizedPhone);

      // Return the state and context (agentState for prospects)
      return res.json({
        phone: normalizedPhone,
        state: (session.context as any)?.agentState || session.state,
        context: (session.context as any)?.agentContext || session.context,
        folioId: session.folioId,
        lastActivity: session.lastActivity
      });
    } catch (error: any) {
      console.error("[ConvState API] GET error:", error.message);
      return res.status(500).json({ error: "Failed to get conversation state" });
    }
  });

  // PATCH /api/conversation-state/:phone — Update state and context
  app.patch("/api/conversation-state/:phone", async (req, res) => {
    try {
      const { phone } = req.params;
      const { state, context } = req.body;

      // Validate required fields
      if (!state || !context) {
        return res.status(400).json({ error: "state and context are required" });
      }

      // Normalize phone
      const normalizedPhone = phone.replace(/^\+?52/, "").replace(/\D/g, "");

      // Valid states for prospects
      const VALID_STATES = [
        "idle",
        "prospect_name",
        "prospect_fuel_type",
        "prospect_consumo",
        "prospect_show_models",
        "prospect_select_model",
        "prospect_tank",
        "prospect_corrida",
        "prospect_confirm",
        "docs_capture",
        "docs_pending",
        "interview_ready",
        "interview_q1", "interview_q2", "interview_q3", "interview_q4",
        "interview_q5", "interview_q6", "interview_q7", "interview_q8",
        "interview_complete",
        "completed"
      ];

      if (!VALID_STATES.includes(state)) {
        return res.status(400).json({ error: `Invalid state: ${state}` });
      }

      // Update session with prospect-compatible structure
      await updateSession(normalizedPhone, {
        state: state as any,
        context: {
          agentState: state,
          agentContext: context
        }
      });

      console.log(`[ConvState API] Updated ${normalizedPhone} → state: ${state}`);

      return res.json({
        success: true,
        phone: normalizedPhone,
        state,
        context
      });
    } catch (error: any) {
      console.error("[ConvState API] PATCH error:", error.message);
      return res.status(500).json({ error: "Failed to update conversation state" });
    }
  });

  // ===== WHATSAPP WEBHOOK (Twilio — receive messages/media, send templates) =====
  const TWILIO_WA_NUMBER = process.env.TWILIO_WA_NUMBER || ""; // whatsapp:+1234567890
  const waEnabled = !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_WA_NUMBER);
  if (waEnabled) console.log("[WhatsApp] Enabled, number:", TWILIO_WA_NUMBER);
  else console.log("[WhatsApp] Not configured (set TWILIO_WA_NUMBER)");

  // Phone → originationId cache (hydrated from DB on first lookup)
  const waPhoneToOrigination = new Map<string, number>();

  // Helper: persist message to whatsapp_messages table
  async function logWaMessage(direction: string, phone: string, body: string, folio?: string, mediaUrl?: string, twilioSid?: string) {
    try {
      const url = process.env.DATABASE_URL;
      if (url) {
        const { neon } = await import("@neondatabase/serverless");
        const sql = neon(url);
        await sql`INSERT INTO whatsapp_messages (direction, phone, folio, body, media_url, twilio_sid) VALUES (${direction}, ${phone}, ${folio || null}, ${body || null}, ${mediaUrl || null}, ${twilioSid || null})`;
      }
    } catch (e: any) {
      console.warn("[WhatsApp] DB log error:", e.message);
    }
  }

  // Helper: persist phone-folio association
  async function associatePhoneFolio(phone: string, folio: string, by: string = "auto") {
    try {
      const url = process.env.DATABASE_URL;
      if (url) {
        const { neon } = await import("@neondatabase/serverless");
        const sql = neon(url);
        await sql`INSERT INTO whatsapp_phone_folio (phone, folio, associated_by) VALUES (${phone}, ${folio}, ${by}) ON CONFLICT (phone, folio) DO NOTHING`;
      }
    } catch (e: any) {
      console.warn("[WhatsApp] Phone-folio assoc error:", e.message);
    }
  }

  // Helper: lookup folio for phone from DB
  async function lookupPhoneFolio(phone: string): Promise<number | null> {
    try {
      const cached = waPhoneToOrigination.get(phone);
      if (cached) return cached;
      const url = process.env.DATABASE_URL;
      if (url) {
        const { neon } = await import("@neondatabase/serverless");
        const sql = neon(url);
        const rows = await sql`SELECT o.id FROM whatsapp_phone_folio wpf JOIN originations o ON o.folio = wpf.folio WHERE wpf.phone = ${phone} ORDER BY wpf.created_at DESC LIMIT 1`;
        if (rows.length > 0) {
          waPhoneToOrigination.set(phone, rows[0].id);
          return rows[0].id;
        }
      }
    } catch (e: any) {
      console.warn("[WhatsApp] Lookup error:", e.message);
    }
    return null;
  }

  // Document keys in order (same as PWA Step 2)
  const WA_DOC_ORDER = [
    "ine_frente", "ine_reverso", "csf", "comprobante_domicilio",
    "concesion", "estado_cuenta", "historial_gnv",
    "factura_vehiculo", "carta_membresia", "selfie_biometrico",
  ];
  const WA_DOC_LABELS: Record<string, string> = {
    ine_frente: "INE Frente",
    ine_reverso: "INE Reverso",
    csf: "Constancia de Situaci\u00f3n Fiscal",
    comprobante_domicilio: "Comprobante de Domicilio",
    concesion: "Concesi\u00f3n de Taxi",
    estado_cuenta: "Estado de Cuenta Bancario",
    historial_gnv: "Historial GNV",
    factura_vehiculo: "Factura del Veh\u00edculo",
    carta_membresia: "Carta de Membres\u00eda",
    selfie_biometrico: "Selfie con INE",
  };

  // Helper: send WhatsApp message via Twilio
  async function sendWa(to: string, body: string, mediaUrl?: string) {
    if (!waEnabled) return { success: false, message: "WhatsApp not configured" };
    try {
      const params: Record<string, string> = {
        From: TWILIO_WA_NUMBER.startsWith("whatsapp:") ? TWILIO_WA_NUMBER : `whatsapp:${TWILIO_WA_NUMBER}`,
        To: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
        Body: body,
      };
      if (mediaUrl) params.MediaUrl = mediaUrl;

      const res = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + TWILIO_SID + "/Messages.json", {
        method: "POST",
        headers: {
          "Authorization": "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(params).toString(),
      });
      const data = await res.json();
      if (!data.sid) {
        console.error(`[WhatsApp] SEND FAILED to ${to} (${body.length} chars): ${data.message || data.error_message || JSON.stringify(data).slice(0, 200)}`);
      } else {
        console.log(`[WhatsApp] Sent to ${to}: ${body.substring(0, 50)}... [${body.length} chars]`, data.sid);
      }
      await logWaMessage("outbound", to.replace("whatsapp:", "").replace("+", ""), body, undefined, mediaUrl, data.sid);
      return { success: !!data.sid, sid: data.sid, message: data.message };
    } catch (err: any) {
      console.error("[WhatsApp] Send error:", err.message);
      return { success: false, message: err.message };
    }
  }

  // GET /api/whatsapp/search-folio?q=... — flexible folio search
  app.get("/api/whatsapp/search-folio", async (req, res) => {
    try {
      const q = (req.query.q as string || "").trim();
      if (!q) return res.json([]);
      const results = await storage.findFolioFlexible(q);
      return res.json(results.map(r => ({
        id: r.origination.id,
        folio: r.origination.folio,
        estado: r.origination.estado,
        taxistaName: r.taxistaName,
        matchType: r.matchType,
      })));
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });


  // POST /api/whatsapp/incoming — AI Agent v9 with Role-Based Routing
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
  let waAgent: any = null;

  // Media queue: process multiple simultaneous images sequentially
  // When promotora sends 4 photos at once, Twilio fires 4 simultaneous requests.
  // Queue them and process one by one — each gets its own OCR + response.
  type MediaQueueItem = {
    From: string; phone: string; body: string;
    mediaUrl: string; mediaType: string; role: any; ProfileName: string;
  };
  const mediaQueues = new Map<string, MediaQueueItem[]>();
  const mediaProcessing = new Map<string, boolean>();

  async function enqueueAndProcessMedia(item: MediaQueueItem): Promise<void> {
    const { phone } = item;
    if (!mediaQueues.has(phone)) mediaQueues.set(phone, []);
    mediaQueues.get(phone)!.push(item);
    if (mediaProcessing.get(phone)) return; // already running, item will be picked up
    mediaProcessing.set(phone, true);
    while ((mediaQueues.get(phone)?.length ?? 0) > 0) {
      const next = mediaQueues.get(phone)!.shift()!;
      try {
        // Wait up to 3s for convState.folioId to be available
        // (race condition: folio created then image sent immediately)
        let folioId: number | null = null;
        for (let attempt = 0; attempt < 6; attempt++) {
          const neonModule = await import("@neondatabase/serverless");
          const sqlCs = neonModule.neon(process.env.DATABASE_URL!);
          const rows = await sqlCs`SELECT folio_id, context FROM conversation_states WHERE phone = ${next.phone}` as any[];
          if (rows[0]?.folio_id) { folioId = rows[0].folio_id; break; }
          // Also check context JSON for originationId (prospect flow stores it there)
          try {
            const ctx = rows[0]?.context;
            const parsed = typeof ctx === 'string' ? JSON.parse(ctx) : ctx;
            const oid = parsed?.agentContext?.originationId || parsed?.originationId;
            if (oid) { folioId = oid; break; }
          } catch {}
          await new Promise(r => setTimeout(r, 500));
        }
        console.log(`[MediaQueue] Processing media for ${next.phone}, folioId=${folioId}`);

        const result = await waAgent.handleMessage(
          next.phone,           // phone
          next.body,            // body
          next.ProfileName,     // profileName
          next.mediaUrl,        // mediaUrl
          next.mediaType,       // mediaType
          folioId,              // originationId (resolved from convState)
          next.role.role,       // role
          next.role.name || next.ProfileName, // roleName
          next.role.permissions || [],         // permissions
        );
        if (result.reply) await sendWa(next.From, result.reply);
      } catch (e: any) {
        console.error(`[MediaQueue] Error for ${next.phone}:`, e.message);
        await sendWa(next.From, `No pude procesar esa imagen. Mándala de nuevo.`);
      }
      if ((mediaQueues.get(phone)?.length ?? 0) > 0) {
        await new Promise(r => setTimeout(r, 1000)); // wait between images
      }
    }
    mediaProcessing.set(phone, false);
  }

  function shouldDebounceMedia(_phone: string): boolean {
    return false; // replaced by media queue
  }
  if (OPENAI_API_KEY) {
    import("./whatsapp-agent").then(mod => {
      waAgent = new mod.WhatsAppAgent(storage, OPENAI_API_KEY);
      console.log("[WhatsApp] AI Agent v7 initialized (GPT-4o mini + Roles)");
    }).catch(err => console.error("[WhatsApp] Agent init failed:", err.message));
  } else {
    console.log("[WhatsApp] No OPENAI_API_KEY — using fallback logic");
  }

  // Helper: generate OTP and send via WhatsApp
  async function sendOTP(phone: string, waFrom: string) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await storage.createOTP(phone, code, expiresAt);
    await sendWa(waFrom, `Tu código de verificación CMU es: *${code}*\nVálido por 10 minutos.`);
    console.log(`[WhatsApp] OTP sent to ${phone}: ${code}`);
  }

  app.post("/api/whatsapp/incoming", async (req, res) => {
    try {
      // QW-1: Validate Twilio webhook signature to prevent spoofing
      const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
      const TWILIO_TOK = process.env.TWILIO_AUTH_TOKEN;
      if (TWILIO_SID && TWILIO_TOK) {
        const twilio = await import("twilio");
        const signature = req.headers["x-twilio-signature"] as string || "";
        const fullUrl = `https://${req.get("host")}${req.originalUrl}`;
        const isValid = twilio.default.validateRequest(TWILIO_TOK, signature, fullUrl, req.body);
        if (!isValid) {
          console.warn(`[WhatsApp] INVALID Twilio signature — possible spoofing attempt`);
          return res.status(403).send("Forbidden: Invalid Twilio signature");
        }
      }

      const { From, Body, NumMedia, ProfileName } = req.body;
      const phone = (From || "").replace("whatsapp:", "").replace(/\+/g, "");
      const body = (Body || "").trim();
      const numMedia = parseInt(NumMedia || "0");
      const hasMedia = numMedia > 0;
      // Collect ALL media URLs (Twilio sends MediaUrl0, MediaUrl1, ...MediaUrlN)
      const allMediaUrls: { url: string; type: string }[] = [];
      for (let i = 0; i < numMedia; i++) {
        const url = req.body[`MediaUrl${i}`];
        const type = req.body[`MediaContentType${i}`] || 'image/jpeg';
        if (url) allMediaUrls.push({ url, type });
      }
      const mediaUrl = allMediaUrls[0]?.url || null;
      const mediaType = allMediaUrls[0]?.type || null;

      console.log(`[WhatsApp] Incoming from ${phone} (${ProfileName}): "${body}" media:${hasMedia}`);
      await logWaMessage("inbound", phone, body, undefined, mediaUrl);

      // Debounce rapid-fire single-image messages
      if (hasMedia && numMedia <= 1 && shouldDebounceMedia(phone)) {
        return res.status(200).send("<Response></Response>");
      }

      // Dedup rapid-fire text messages from same phone (< 3s apart)
      const TEXT_DEDUP_MS = 3000;
      const textDedupKey = `${phone}:${body.toLowerCase().trim()}`;
      const lastTextTime = (globalThis as any).__textDedup?.[textDedupKey] || 0;
      const now = Date.now();
      if (!body && !hasMedia) {
        return res.status(200).send("<Response></Response>");
      }
      if (body && !hasMedia && (now - lastTextTime) < TEXT_DEDUP_MS) {
        console.log(`[Dedup] Ignoring duplicate text from ${phone}: "${body.slice(0, 40)}"`);
        return res.status(200).send("<Response></Response>");
      }
      if (body) {
        (globalThis as any).__textDedup = (globalThis as any).__textDedup || {};
        (globalThis as any).__textDedup[textDedupKey] = now;
        // Cleanup old entries every 100 messages
        const keys = Object.keys((globalThis as any).__textDedup);
        if (keys.length > 200) {
          const cutoff = now - 60000;
          for (const k of keys) { if ((globalThis as any).__textDedup[k] < cutoff) delete (globalThis as any).__textDedup[k]; }
        }
      }

      // Multi-image: ask user to send one at a time
      if (numMedia > 1) {
        console.log(`[WhatsApp] Multi-image rejected: ${numMedia} images from ${phone}`);
        const twiml = `<Response><Message>Recib\u00ed ${numMedia} fotos a la vez. Para que pueda verificar cada documento correctamente, m\u00e1ndalos *de uno en uno*. Empieza con el primero \ud83d\udcf7</Message></Response>`;
        return res.status(200).type('text/xml').send(twiml);
      }

      // ===== STEP 1: ROLE LOOKUP =====
      const role = await storage.getRoleByPhone(phone);
      console.log(`[WhatsApp] Role for ${phone}:`, role ? `${role.role} (${role.name})` : "UNKNOWN");

      // ===== STEP 2: HANDLE UNKNOWN NUMBERS =====
      // Unknown numbers are treated as PROSPECTOS (informational mode)
      // They can ask anything about the program. NO automatic registration.
      // Only register when they explicitly say they want to sign up.
      if (!role) {
        // Check if they're typing an OTP code (6 digits) from a pending registration
        const otpMatch = body.match(/^\d{6}$/);
        if (otpMatch) {
          const result = await storage.verifyOTP(phone, otpMatch[0]);
          if (result.valid) {
            await sendWa(From, "✅ *Número verificado.* ¡Bienvenido al programa CMU!\n\nSoy tu asistente. ¿En qué te puedo ayudar?");
          } else {
            await sendWa(From, "❌ Código incorrecto o expirado.");
          }
          return res.status(200).send("<Response></Response>");
        }

        // Check if they want to register
        const lowerBody = body.toLowerCase();
        const wantsToRegister = lowerBody.includes("registrar") || lowerBody.includes("inscribir")
          || lowerBody.includes("quiero entrar") || lowerBody.includes("quiero aplicar")
          || lowerBody.includes("me interesa registrarme") || lowerBody.includes("como me registro")
          || lowerBody.includes("acepto") || lowerBody.includes("si quiero");

        if (wantsToRegister) {
          // NOW start registration
          await storage.createRole(phone, "prospecto", ProfileName || null, []);
          await sendOTP(phone, From);
          await sendWa(From, `¡Perfecto! Para iniciar tu registro, verifica tu número con el código que te acabo de enviar.`);
          return res.status(200).send("<Response></Response>");
        }

        // Route to modular agent v3 for prospectos
        // CRITICAL: ALL prospect messages (text, images, audio) go through the orchestrator.
        // The orchestrator owns the prospect state (folio, docs, interview).
        // Do NOT use enqueueAndProcessMedia — that routes through waAgent which
        // doesn't know about the orchestrator's folio/state.
        const runProspectV3 = async () => {
          const reply = await handleProspectMessage(
            phone, body,
            hasMedia ? mediaUrl : null, hasMedia ? (mediaType || "image/jpeg") : null,
            ProfileName || "", storage,
          );
          await sendWa(From, reply);
        };
        runProspectV3().catch(e => {
          console.error(`[AgentV3] Error for ${phone}:`, e.message);
          sendWa(From, `Ocurrió un error. Intenta de nuevo.`);
        });
        return res.status(200).send("<Response></Response>");
      }

      // ===== STEP 3: HANDLE UNVERIFIED NUMBERS (registered but not verified) =====
      if (!role.phone_verified) {
        const otpMatch = body.match(/^\d{6}$/);
        if (otpMatch) {
          const result = await storage.verifyOTP(phone, otpMatch[0]);
          if (result.valid) {
            await sendWa(From, "✅ *Número verificado.* ¡Listo! ¿En qué te puedo ayudar?");
          } else if (result.expired || result.maxAttempts) {
            await sendOTP(phone, From);
            await sendWa(From, "Código expirado. Te envío uno nuevo.");
          } else {
            await sendWa(From, "❌ Código incorrecto. Inténtalo de nuevo.");
          }
        } else {
          // Route to modular agent v3
          try {
            const reply = await handleProspectMessage(
              phone, body,
              hasMedia ? mediaUrl : null, mediaType || null,
              role.name || ProfileName || "", storage,
            );
            await sendWa(From, reply);
          } catch (e: any) {
            console.error(`[AgentV3] Error for ${phone}:`, e.message);
            await sendWa(From, `Ocurrió un error. Intenta de nuevo.`);
          }
        }
        return res.status(200).send("<Response></Response>");
      }

      // ===== STEP 4: VERIFIED USER — ROUTE TO CANAL =====
      const folioMatch = body.match(/CMU-(?:VAL|CPV|COM|ORI)-\d{6}-\d{3}/i) || body.match(/CMU-(?:VAL|CPV|COM|ORI)-\d{3,}/i);
      let originationId = role.folio_id || (await lookupPhoneFolio(phone));

      if (folioMatch) {
        const folioStr = folioMatch[0].toUpperCase();
        const orig = await storage.getOriginationByFolio(folioStr);
        if (orig) {
          originationId = orig.id;
          waPhoneToOrigination.set(phone, orig.id);
          await associatePhoneFolio(phone, folioStr, "text_match");
        }
      }

      // === ROUTED AGENT MODE (message-router is single entry point) ===
      if (waAgent && OPENAI_API_KEY) {
        // Media handling: prospects go through orchestrator, privileged roles through queue
        if (hasMedia && mediaUrl) {
          if (role.role === "prospecto") {
            // Prospects: orchestrator owns state (folio, docs, interview)
            handleProspectMessage(phone, body, mediaUrl, mediaType || "image/jpeg", role.name || ProfileName || "", storage)
              .then(reply => { if (reply) sendWa(From, reply); })
              .catch(e => { console.error("[AgentV3/media] Error:", e.message); sendWa(From, "Ocurri\u00f3 un error. Intenta de nuevo."); });
          } else {
            // Director/promotora: queue preserves OCR ordering for doc capture
            enqueueAndProcessMedia({
              From, phone, body,
              mediaUrl: mediaUrl!, mediaType: mediaType || "image/jpeg",
              role, ProfileName: ProfileName || "",
            }).catch(e => console.error("[MediaQueue] Fatal:", e.message));
          }
          return res.status(200).send("<Response></Response>");
        }

        try {
          const reply = await routeMessage(
            phone,
            body,
            ProfileName || "",
            null,
            null,
            { role: role.role, name: role.name || "", permissions: role.permissions || [] },
            { waAgent, storage },
          );
          if (reply) await sendWa(From, reply);
        } catch (e: any) {
          console.error(`[Router] Error for ${phone}:`, e.message);
          await sendWa(From, `Ocurrió un error. Intenta de nuevo.`);
        }
        return res.status(200).send("<Response></Response>");
      }

      // === FALLBACK (no OpenAI key) ===
      await sendWa(From, `🚗 *CMU*\n\nHola ${role.name || ""} (${role.role}). El asistente necesita configuración para funcionar.`);
      return res.status(200).send("<Response></Response>");
    } catch (err: any) {
      console.error("[WhatsApp] Incoming error:", err);
      // Try to send error reply so user doesn't get silent failure
      try {
        const errPhone = req.body?.From;
        if (errPhone && typeof sendWa === "function") {
          await sendWa(errPhone, `Lo siento, ocurrio un error procesando tu mensaje. Intenta de nuevo en unos segundos.`);
        }
      } catch {}
      return res.status(200).send("<Response></Response>");
    }
  });

  // POST /api/whatsapp/send — Send a message from the PWA
  app.post("/api/whatsapp/send", async (req, res) => {
    try {
      const { to, body, mediaUrl, templateSid, templateVars } = req.body;
      if (!to || (!body && !templateSid)) {
        return res.status(400).json({ message: "Se requiere 'to' y 'body' o 'templateSid'" });
      }

      // If template, use Content API
      if (templateSid) {
        const params: Record<string, string> = {
          From: TWILIO_WA_NUMBER.startsWith("whatsapp:") ? TWILIO_WA_NUMBER : `whatsapp:${TWILIO_WA_NUMBER}`,
          To: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
          ContentSid: templateSid,
        };
        if (templateVars) params.ContentVariables = JSON.stringify(templateVars);

        const twilioRes = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + TWILIO_SID + "/Messages.json", {
          method: "POST",
          headers: {
            "Authorization": "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(params).toString(),
        });
        const data = await twilioRes.json();
        return res.json({ success: !!data.sid, sid: data.sid, message: data.message });
      }

      // Plain message
      const result = await sendWa(to, body, mediaUrl);
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // GET /api/whatsapp/log — View recent messages from DB
  app.get("/api/whatsapp/log", async (_req, res) => {
    try {
      const url = process.env.DATABASE_URL;
      if (url) {
        const { neon } = await import("@neondatabase/serverless");
        const sql = neon(url);
        const rows = await sql`SELECT * FROM whatsapp_messages ORDER BY created_at DESC LIMIT 100`;
        return res.json(rows);
      }
      return res.json([]);
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // CMU payment constants
  const CMU = { clabe: "152680120000787681", banco: "Bancrea" };

  // POST /api/whatsapp/payment-link — Generate a Conekta payment link and send via WhatsApp
  app.post("/api/whatsapp/payment-link", async (req, res) => {
    try {
      const { phone, originationId, amount, concept } = req.body;
      if (!phone || !amount) return res.status(400).json({ message: "Se requiere 'phone' y 'amount'" });

      // Get origination info for reference
      let folio = "CMU";
      let customerName = "Operador CMU";
      if (originationId) {
        const orig = await storage.getOrigination(originationId);
        if (orig) {
          folio = (orig as any).folio;
          const tid = (orig as any).taxistaId || (orig as any).taxista_id;
          if (tid) {
            const t = await storage.getTaxista(tid);
            if (t) customerName = `${(t as any).nombre} ${(t as any).apellidoPaterno || (t as any).apellido_paterno || ""}`;
          }
        }
      }

      // Create Conekta order
      const CONEKTA_KEY = process.env.CONEKTA_PRIVATE_KEY;
      let checkoutUrl: string | null = null;
      let orderId: string | null = null;

      if (CONEKTA_KEY) {
        const conektaRes = await fetch("https://api.conekta.io/orders", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/vnd.conekta-v2.2.0+json",
            "Authorization": "Basic " + Buffer.from(`${CONEKTA_KEY}:`).toString("base64"),
          },
          body: JSON.stringify({
            currency: "MXN",
            customer_info: { name: customerName, email: "operador@cmu.mx", phone: phone.replace(/\D/g, "").slice(-10) },
            line_items: [{ name: concept || `Mensualidad CMU - ${folio}`, unit_price: amount * 100, quantity: 1 }],
            charges: [{ payment_method: { type: "default" } }],
            metadata: { origination_id: String(originationId || ""), folio },
          }),
        });
        const data = await conektaRes.json();
        if (data.id) {
          orderId = data.id;
          checkoutUrl = data.checkout?.url || null;
        }
      }

      if (!checkoutUrl) {
        checkoutUrl = `https://cmu-originacion.fly.dev/#/pago?folio=${folio}&monto=${amount}`;
        orderId = `sim-${Date.now()}`;
      }

      // Send via WhatsApp
      const msg = `💰 *Liga de pago CMU*\n\nFolio: ${folio}\nConcepto: ${concept || "Mensualidad"}\nMonto: $${amount.toLocaleString()} MXN\n\nPaga aquí: ${checkoutUrl}\n\nMétodos: OXXO, transferencia bancaria, SPEI\nTienes 5 días hábiles.\n\nO deposita a CLABE: ${CMU.clabe} (${CMU.banco})\nReferencia: ${folio}`;

      if (waEnabled) {
        await sendWa(phone, msg);
      }

      return res.json({ success: true, orderId, checkoutUrl, message: "Liga enviada" });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // POST /api/whatsapp/associate — Manually associate a phone to a folio
  app.post("/api/whatsapp/associate", async (req, res) => {
    try {
      const { phone, originationId } = req.body;
      if (!phone || !originationId) {
        return res.status(400).json({ message: "Se requiere 'phone' y 'originationId'" });
      }
      waPhoneToOrigination.set(phone.replace("whatsapp:", ""), originationId);
      return res.json({ success: true, message: `Tel\u00e9fono ${phone} asociado a originaci\u00f3n ${originationId}` });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // POST /api/whatsapp/send-outbound — Send WhatsApp message to external contact
  app.post("/api/whatsapp/send-outbound", async (req, res) => {
    try {
      const { to, body } = req.body;
      if (!to || !body) return res.status(400).json({ message: "to and body required" });
      const toFormatted = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
      await sendWa(toFormatted, body);
      return res.json({ success: true, to: toFormatted, message: "Sent" });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // POST /api/cron/cierre — Monthly close (run on day 1)
  app.post("/api/cron/cierre", async (req, res) => {
    try {
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret) {
        const provided = req.headers["x-cron-secret"] || req.query.secret;
        if (provided !== cronSecret) return res.status(401).json({ message: "Invalid cron secret" });
      }
      const sendWaForCierre = async (to: string, body: string) => sendWa(to, body);
      const result = await cierreMensual(sendWaForCierre);
      return res.json({ success: true, timestamp: new Date().toISOString(), ...result });
    } catch (err: any) {
      console.error("[Cron] Cierre mensual error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  // POST /api/cron/proactive — Run proactive checks (called by Fly.io scheduled machine or external cron)
  app.post("/api/cron/proactive", async (req, res) => {
    try {
      // Optional auth via header or query param
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret) {
        const provided = req.headers["x-cron-secret"] || req.query.secret;
        if (provided !== cronSecret) {
          return res.status(401).json({ message: "Invalid cron secret" });
        }
      }

      const sendWaForCron = async (to: string, body: string) => {
        return sendWa(to, body);
      };

      const results = await runAllProactiveChecks(storage, sendWaForCron);
      return res.json({
        success: true,
        timestamp: new Date().toISOString(),
        results,
      });
    } catch (err: any) {
      console.error("[Cron] Proactive check error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  // POST /api/cron/aviso-dia25 — Estado de cuenta proactivo al conductor el día 25.
  // Para TSR: recaudo del mes + cuota + diferencial estimado + ETA liga.
  // Para Joylong: acumulado + gatillo + % avance.
  app.post("/api/cron/aviso-dia25", async (req, res) => {
    try {
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret) {
        const provided = req.headers["x-cron-secret"] || req.query.secret;
        if (provided !== cronSecret) {
          return res.status(401).json({ message: "Invalid cron secret" });
        }
      }
      const { avisoRecaudoDia25 } = await import("./conductor-proactivo-engine");
      const sendWaForCron = async (to: string, body: string) => sendWa(to, body);
      const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;
      const result = await avisoRecaudoDia25(sendWaForCron, { dryRun });
      return res.json({
        success: true,
        dryRun,
        timestamp: new Date().toISOString(),
        enviados: result.enviados,
        errores: result.errores,
        detalle: result.detalle,
      });
    } catch (err: any) {
      console.error("[Cron] Aviso dia25 error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  // POST /api/originations/:id/notify-post-firma — Notificación consolidada al firmar.
  // Llamable manualmente o desde el flujo de Mifiel webhook cuando el status cambia a 'signed'.
  app.post("/api/originations/:id/notify-post-firma", requireRole("director", "dev", "promotora"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const orig = await storage.getOrigination(id);
      if (!orig) return res.status(404).json({ message: "Folio no encontrado" });
      const taxista = orig.taxistaId ? await storage.getTaxista(orig.taxistaId) : null;
      const vehicle = orig.vehicleInventoryId ? await storage.getVehicle(orig.vehicleInventoryId) : null;

      const { notificarPostFirma } = await import("./conductor-proactivo-engine");
      const nombre = taxista ? `${taxista.nombre} ${taxista.apellidoPaterno || ""}`.trim() : "";
      const telefono = taxista?.telefono || orig.otpPhone || "";

      // Cuota estimada: si hay PV en orig.notes o calcular desde motor
      let cuotaMensual = 0;
      let precioTotal = 0;
      try {
        const meta = orig.notes ? JSON.parse(orig.notes) : null;
        if (meta?.cuota) cuotaMensual = Number(meta.cuota);
        if (meta?.pv) precioTotal = Number(meta.pv);
      } catch { /* nada */ }

      const sendWaForNotify = async (to: string, body: string) => sendWa(to, body);
      const result = await notificarPostFirma({
        folio: orig.folio,
        nombreTaxista: nombre,
        telefonoTaxista: telefono,
        marca: vehicle?.marca,
        modelo: vehicle?.modelo,
        anio: vehicle?.anio,
        cuotaMensual,
        precioTotal,
        fechaFirma: orig.contractGeneratedAt || new Date().toISOString(),
      }, sendWaForNotify, JOSUE_PHONE, ANGELES_PHONE);

      return res.json({ success: true, folio: orig.folio, result });
    } catch (err: any) {
      console.error("[PostFirma] failed:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  // POST /api/cron/abandono — Detecta placas sin cargas de GNV por 3+ días.
  // Escalera: 3d log, 5d WhatsApp al conductor, 7d escalar a director + promotor.
  app.post("/api/cron/abandono", async (req, res) => {
    try {
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret) {
        const provided = req.headers["x-cron-secret"] || req.query.secret;
        if (provided !== cronSecret) {
          return res.status(401).json({ message: "Invalid cron secret" });
        }
      }

      const { detectarAbandonoPorPlaca, notificarAbandono } = await import("./abandono-engine");

      const entries = await detectarAbandonoPorPlaca();
      const sendWaForCron = async (to: string, body: string) => {
        return sendWa(to, body);
      };

      const result = await notificarAbandono(
        entries,
        sendWaForCron,
        JOSUE_PHONE,
        ANGELES_PHONE,
      );

      return res.json({
        success: true,
        timestamp: new Date().toISOString(),
        totalDetectadas: entries.length,
        porSeveridad: {
          warning: entries.filter(e => e.severidad === "warning").length,
          alert: entries.filter(e => e.severidad === "alert").length,
          critical: entries.filter(e => e.severidad === "critical").length,
        },
        notificados: result.notificados,
        escalados: result.escalados,
        errores: result.errores,
        detalle: entries,
      });
    } catch (err: any) {
      console.error("[Cron] Abandono check error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  // POST /api/recaudo/process — Process NATGAS Excel/CSV (called by Gmail cron)
  // Multi-product: routes each placa to Joylong Ahorro, Kit Conversión, or Taxi Renovación
  // Dedup: SHA-256 hash prevents double-processing the same file
  app.post("/api/recaudo/process", async (req, res) => {
    try {
      const { fileBase64, filename } = req.body;
      if (!fileBase64) return res.status(400).json({ message: "fileBase64 required" });
      
      const buffer = Buffer.from(fileBase64, "base64");
      
      // Dedup check: skip if this exact file was already processed (persistent in Neon DB)
      if (await isDuplicateFile(buffer)) {
        console.log(`[Recaudo API] Duplicate file detected (${filename}) — skipping`);
        return res.json({ success: true, duplicate: true, message: "Este archivo ya fue procesado anteriormente. No se volvio a sumar." });
      }
      
      const isExcel = (filename || "").toLowerCase().endsWith(".xlsx") || (filename || "").toLowerCase().endsWith(".xls");
      
      // Parse into NatgasRow[] directly (no lossy CSV round-trip)
      const rows = isExcel ? parseNatgasExcel(buffer) : parseNatgasCsvRows(buffer.toString("utf-8"));
      if (rows.length === 0) {
        return res.json({ success: false, error: "No CMU rows found", summary: { totalRows: 0, totalRecaudo: 0, totalLitros: 0, creditosActualizados: 0, placasNoEncontradas: [], detalle: [], periodo: "", joylong: { contratos: 0, recaudo: 0, detalle: [] }, kitConversion: { contratos: 0, recaudo: 0, detalle: [] }, taxiRenovacion: { contratos: 0, recaudo: 0, detalle: [] } } });
      }
      
      // Process through multi-product engine
      const summary = await processNatgasMultiProduct(rows);
      
      // Mark as processed AFTER successful processing (persistent in Neon DB)
      await markFileProcessed(buffer, filename);
      
      return res.json({ success: true, summary, formatted: formatRecaudoSummary(summary) });
    } catch (err: any) {
      console.error("[Recaudo API] Error:", err);
      return res.status(500).json({ message: err.message });
    }
  });

  // POST /api/recaudo/fix-ahorro — Director override to correct Joylong ahorro accumulated values
  app.post("/api/recaudo/fix-ahorro", async (req, res) => {
    try {
      const { pin, correcciones } = req.body;
      if (pin !== "654321") return res.status(403).json({ message: "PIN incorrecto" });
      const AIRTABLE_TOKEN = process.env.AIRTABLE_PAT || process.env.AIRTABLE_TOKEN || "";
      if (!AIRTABLE_TOKEN) return res.status(500).json({ message: "AIRTABLE_PAT not set" });

      const BASE_ID = "appXxbjjGzXFiX7gk";
      const TABLE_ID = "tblUjkOQ2rWvBRRmw"; // Ahorro Joylong

      const results: any[] = [];
      for (const c of correcciones) {
        // Find record by Folio
        const listResp = await fetch(
          `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}?filterByFormula=%7BFolio%7D%3D'${c.folio}'`,
          { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
        );
        const listData: any = await listResp.json();
        if (!listData.records?.length) { results.push({ folio: c.folio, error: "not found" }); continue; }
        const recId = listData.records[0].id;
        // Update record
        const upResp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}/${recId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { "Ahorro Acumulado": c.ahorro_acumulado, "Notas": c.notas || "" } })
        });
        const upData: any = await upResp.json();
        results.push({ folio: c.folio, ahorro: upData.fields?.["Ahorro Acumulado"], ok: !upData.error });
      }
      return res.json({ success: true, results });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // GET /api/expedientes/bloqueados — folios with audit errors (promotor/director)
  app.get("/api/expedientes/bloqueados", async (_req, res) => {
    try {
      const { neon: neonExp } = await import("@neondatabase/serverless");
      const sqlE = neonExp(process.env.DATABASE_URL!);
      const rows = await sqlE`
        SELECT o.id, o.folio, o.estado, o.updated_at, o.created_at,
          cs.context,
          CONCAT(t.nombre, ' ', t.apellido_paterno, ' ', COALESCE(t.apellido_materno, '')) as nombre,
          t.telefono
        FROM originations o
        LEFT JOIN taxistas t ON t.id = o.taxista_id
        LEFT JOIN conversation_states cs ON cs.folio_id = o.id
        WHERE o.estado NOT IN ('RECHAZADO', 'CANCELADO')
          AND (t.telefono IS NULL OR t.telefono NOT LIKE '521999%')
        ORDER BY o.updated_at DESC
      ` as any[];

      const { auditExpediente } = await import("./agent/post-ocr-validation");

      const bloqueados = [];
      for (const row of rows) {
        const ctx = typeof row.context === 'string' ? JSON.parse(row.context) : (row.context || {});
        const allDocs = ctx.existingData || {};
        const docsCollected = ctx.docsCollected || [];
        if (Object.keys(allDocs).length === 0) continue; // no docs yet
        
        const audit = auditExpediente(allDocs);
        const errors = audit.alerts.filter((a: any) => a.severity === 'error');
        
        if (errors.length > 0) {
          bloqueados.push({
            folio: row.folio,
            nombre: row.nombre?.trim(),
            telefono: row.telefono,
            estado: row.estado,
            docsCollected: docsCollected.length,
            updatedAt: row.updated_at,
            errors: errors.map((e: any) => ({
              field: e.field,
              message: e.message,
              docs: e.docs,
              values: e.values,
            })),
            warnings: audit.alerts.filter((a: any) => a.severity === 'warning').map((w: any) => w.message),
          });
        }
      }

      return res.json({ total: bloqueados.length, bloqueados });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/recaudo/admin — Generic Airtable admin operations (director PIN required)
  // PIN-gated admin ops for originations (cancel/delete test folios without UI auth).
  app.post("/api/originations/admin", async (req, res) => {
    try {
      const { pin, action, folio, id, estado, notes } = req.body || {};
      if (pin !== "654321") return res.status(403).json({ message: "PIN incorrecto" });
      let orig: any = null;
      if (id) orig = await storage.getOrigination(parseInt(id));
      else if (folio) orig = await storage.getOriginationByFolio(folio);
      if (!orig) return res.status(404).json({ message: "Folio no encontrado" });
      if (action === "cancel") {
        const updated = await storage.updateOrigination(orig.id, {
          estado: estado || "CANCELADO",
          notes: notes || (orig.notes ? orig.notes + " | " : "") + `Cancelado admin ${new Date().toISOString().slice(0,10)}`,
          updatedAt: new Date().toISOString(),
        } as any);
        return res.json({ success: true, origination: updated });
      }
      if (action === "delete") {
        const sql = (storage as any).sql;
        if (!sql) return res.status(500).json({ message: "DB not available" });
        await sql`DELETE FROM originations WHERE id = ${orig.id}`;
        return res.json({ success: true, deletedId: orig.id, folio: orig.folio });
      }
      return res.status(400).json({ message: "action must be cancel|delete" });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/recaudo/admin", async (req, res) => {
    try {
      const { pin, action, table, fields, recordId, formula } = req.body;
      if (pin !== "654321") return res.status(403).json({ message: "PIN incorrecto" });
      const AIRTABLE_TOKEN = process.env.AIRTABLE_PAT || process.env.AIRTABLE_TOKEN || "";
      if (!AIRTABLE_TOKEN) return res.status(500).json({ message: "AIRTABLE_PAT not set" });
      const BASE_ID = "appXxbjjGzXFiX7gk";
      const headers = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" };

      if (action === "create") {
        const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${table}`, {
          method: "POST", headers,
          body: JSON.stringify({ records: [{ fields }], typecast: true }),
        });
        const data: any = await resp.json();
        return res.json({ success: !data.error, data });
      }
      if (action === "update" && recordId) {
        const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${table}/${recordId}`, {
          method: "PATCH", headers,
          body: JSON.stringify({ fields }),
        });
        const data: any = await resp.json();
        return res.json({ success: !data.error, data });
      }
      if (action === "delete" && recordId) {
        const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${table}/${recordId}`, {
          method: "DELETE", headers,
        });
        const data: any = await resp.json();
        return res.json({ success: !data.error, data });
      }
      if (action === "list") {
        const qs = formula ? `?filterByFormula=${encodeURIComponent(formula)}` : "";
        const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${table}${qs}`, { headers });
        const data: any = await resp.json();
        return res.json({ success: true, records: (data.records || []).map((r: any) => ({ id: r.id, ...r.fields })) });
      }
      return res.status(400).json({ message: "action must be create|update|delete|list" });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  // ===== EVALUACIÓN RÁPIDA TAXI =====
  app.use("/api/evaluacion", evaluacionRoutes);

  // ===== AGENT SANDBOX =====
  app.post("/api/agent/sandbox", async (req, res) => {
    try {
      const { message, simulateRole, sessionId } = req.body;
      if (!message) return res.status(400).json({ error: "message required" });

      const role = simulateRole || "prospecto";
      const sandboxPhone = `sandbox_${sessionId || "default"}_${role}`;

      // Map role to a fake phone context
      const roleMap: Record<string, { role: string; name: string | null }> = {
        prospecto: { role: "prospecto", name: null },
        cliente: { role: "cliente", name: "Cliente Test" },
        promotora: { role: "promotora", name: getPromotor()?.nombre || "Promotor CMU" },
        director: { role: "director", name: DIRECTOR.nombre },
      };
      const simRole = roleMap[role] || roleMap.prospecto;

      // Collect debug info
      const debugLog: string[] = [];
      const startTime = Date.now();
      debugLog.push(`[Sandbox] Role: ${simRole.role}, Phone: ${sandboxPhone}`);

      // Get conversation state for debug
      const convStateBefore = await waAgent.getConvState(sandboxPhone);
      debugLog.push(`[State Before] ${JSON.stringify(convStateBefore.state || "idle")}`);

      // Call the actual agent handler
      const result = await waAgent.handleMessage(
        sandboxPhone, message, null, null,
        null, // no origination ID
        simRole.role, simRole.name, [],
      );

      const convStateAfter = await waAgent.getConvState(sandboxPhone);
      const elapsed = Date.now() - startTime;
      debugLog.push(`[State After] ${JSON.stringify(convStateAfter.state || "idle")}`);
      debugLog.push(`[Context] ${JSON.stringify(convStateAfter.context || {})}`);
      debugLog.push(`[Latency] ${elapsed}ms`);

      res.json({
        success: true,
        reply: result.reply,
        debug: {
          role: simRole.role,
          phone: sandboxPhone,
          stateBefore: convStateBefore.state || "idle",
          stateAfter: convStateAfter.state || "idle",
          context: convStateAfter.context || {},
          latencyMs: elapsed,
          logs: debugLog,
          documentSaved: result.documentSaved,
          newOriginationId: result.newOriginationId,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== PIPELINE DE VENTAS =====
  app.get("/api/pipeline/stats", async (_req, res) => {
    try {
      const stats = await getPipelineStats();
      res.json({ success: true, ...stats });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/pipeline/list", async (req, res) => {
    try {
      const { canal, status, limit } = req.query;
      const prospects = await getPipelineList({
        canal: canal as string,
        status: status as string,
        limit: limit ? parseInt(limit as string) : 100,
      });
      res.json({ success: true, prospects });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/pipeline/canales", async (_req, res) => {
    try {
      const canales = await getCanales();
      res.json({ success: true, canales });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/pipeline/followup", async (_req, res) => {
    try {
      const followups = await getProspectsNeedingFollowup();
      res.json({ success: true, ...followups });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/pipeline/qr/:canalCode", async (req, res) => {
    try {
      const canales = await getCanales();
      const canal = canales.find((c: any) => c.codigo === req.params.canalCode);
      if (!canal) return res.status(404).json({ error: "Canal no encontrado" });
      const waNumber = "524463293102"; // CMU WhatsApp number for wa.me (52 + 10 digits, no '1')
      const link = generateWhatsAppLink(waNumber, canal.codigo, canal.qr_mensaje);
      res.json({ success: true, canal: canal.codigo, nombre: canal.nombre, whatsapp_link: link, qr_mensaje: canal.qr_mensaje });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== PIPELINE FOLLOWUP =====
  app.post("/api/pipeline/run-followup", async (_req, res) => {
    try {
      const followups = await getProspectsNeedingFollowup();
      let sent = 0;
      const results: string[] = [];

      // 3-day cold prospects
      for (const p of followups.frios_3d) {
        const msg = `Hola${p.nombre ? " " + p.nombre.split(" ")[0] : ""}. La otra vez preguntaste por nuestro programa de taxis con gas natural. \u00bfTe interesa que te platique c\u00f3mo funciona?`;
        try {
          await fetch("http://localhost:5000/api/whatsapp/send-outbound", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: `whatsapp:+${p.phone.replace(/\D/g, "")}`, body: msg }),
          });
          await markFollowupSent(p.phone);
          sent++;
          results.push(`3d: ${p.nombre || p.phone}`);
        } catch (e) { /* non-blocking */ }
      }

      // 5-day registered without docs — remind prospect + notify promotor with detail
      for (const p of followups.sin_docs_5d) {
        // Get pending docs from folio if exists
        let pendingDocs = "INE, comprobante de domicilio, concesi\u00f3n";
        if (p.folio_id) {
          try {
            const folioRes = await fetch(`http://localhost:5000/api/originations?folio=${encodeURIComponent(p.folio_id)}`).then(r => r.json()).catch(() => null);
            // Use generic list for now — agent will check specifics in conversation
          } catch (e) { /* use default */ }
        }
        const msgProspect = `Hola${p.nombre ? " " + p.nombre.split(" ")[0] : ""}. Ya est\u00e1s registrado en el programa CMU. Para avanzar necesitamos tus documentos. \u00bfMe mandas tu *INE* (frente y reverso) por aqu\u00ed?`;
        const msgAngeles = `\u26a0\ufe0f *Seguimiento 5d sin docs*\n${p.nombre || "Sin nombre"} (${p.phone})\nCanal: ${p.canal_origen}\nFolio: ${p.folio_id || "sin folio"}\nDocs: ${p.docs_completados}/${p.docs_total}\n\nSe le envi\u00f3 recordatorio por WhatsApp. Puedes contactarlo directamente.`;
        try {
          // Remind prospect
          await fetch("http://localhost:5000/api/whatsapp/send-outbound", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: `whatsapp:+${p.phone.replace(/\D/g, "")}`, body: msgProspect }),
          });
          // Notify promotor
          await fetch("http://localhost:5000/api/whatsapp/send-outbound", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: "whatsapp:+" + (getPromotor()?.phone || ANGELES_PHONE), body: msgAngeles }),
          });
          await markFollowupSent(p.phone);
          sent++;
          results.push(`5d: ${p.nombre || p.phone} (prospecto + \u00c1ngeles)`);
        } catch (e) { /* non-blocking */ }
      }

      // 7-day incomplete docs — notify promotor + Josu\u00e9 with specific missing docs
      for (const p of followups.incompletos_7d) {
        const msg = `\u26a0\ufe0f *Prospecto 7d sin completar docs*\n*${p.nombre || "Sin nombre"}* (${p.phone})\nCanal: ${p.canal_origen}\nFolio: ${p.folio_id || "sin folio"}\nDocs: *${p.docs_completados} de ${p.docs_total}*\nFaltan: ${p.docs_total - p.docs_completados} documentos\n\nContactar para completar expediente.`;
        try {
          await fetch("http://localhost:5000/api/whatsapp/send-outbound", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: "whatsapp:+" + (getPromotor()?.phone || ANGELES_PHONE), body: msg }),
          });
          await fetch("http://localhost:5000/api/whatsapp/send-outbound", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: `whatsapp:+${JOSUE_PHONE}`, body: msg }),
          });
          await markFollowupSent(p.phone);
          sent++;
          results.push(`7d: ${p.nombre || p.phone} (\u00c1ngeles+Josu\u00e9)`);
        } catch (e) { /* non-blocking */ }
      }

      res.json({ success: true, sent, results, summary: `${followups.frios_3d.length} fr\u00edos 3d, ${followups.sin_docs_5d.length} sin docs 5d, ${followups.incompletos_7d.length} incompletos 7d` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== AUDIT TRAIL =====
  initAuditTable().catch((e) => console.error("[Audit] Init failed:", e.message));

  // ===== AVISO DE PRIVACIDAD (LFPDPPP) =====
  initAvpTable().catch((e) => console.error("[AVP] Init failed:", e.message));

  // ===== OCR PROVENANCE (AVP v3 Cláusula V bis inciso c) =====
  initOcrProvenanceTable().catch((e) => console.error("[OcrProvenance] Init failed:", e.message));

  // ARCO-acceso: el Titular puede consultar qué proveedores han procesado sus docs.
  app.get("/api/aviso-privacidad/ocr-history", async (req, res) => {
    try {
      const phone = String(req.query.phone || "").trim();
      if (!phone) return res.status(400).json({ message: "phone es obligatorio" });
      const rows = await getOcrHistoryForPhone(phone);
      res.json({ phone, entries: rows });
    } catch (e: any) {
      console.error("[AVP] OCR history failed:", e.message);
      res.status(500).json({ message: e.message });
    }
  });

  // GET: devuelve la versión vigente y si el teléfono ya tiene aceptación al día.
  // Se usa al primer login en la PWA para decidir si mostrar el modal de aviso.
  app.get("/api/aviso-privacidad", async (req, res) => {
    try {
      const phone = String(req.query.phone || "").trim();
      const currentVersion = AVP_CURRENT_VERSION;
      const vigenteDesde = AVP_VIGENTE_DESDE;
      if (!phone) {
        return res.json({ currentVersion, vigenteDesde, accepted: false, needsAcceptance: true });
      }
      const latest = await getLatestAcceptance(phone);
      if (!latest) {
        return res.json({ currentVersion, vigenteDesde, accepted: false, needsAcceptance: true });
      }
      return res.json({
        currentVersion,
        vigenteDesde,
        accepted: true,
        needsAcceptance: !latest.isCurrent,
        acceptedVersion: latest.record.version,
        acceptedAt: latest.record.accepted_at,
        folio: latest.record.folio,
        consentSecundarias: latest.record.consent_secundarias === 1,
      });
    } catch (e: any) {
      console.error("[AVP] GET failed:", e.message);
      res.status(500).json({ message: e.message });
    }
  });

  // POST: registra una aceptación del AVP.
  // Requiere verificación previa de OTP vía Twilio Verify (otp_code vigente).
  // Guarda IP, User Agent, sello OTP y pdf_base64 del documento congelado.
  app.post("/api/aviso-privacidad/accept", async (req, res) => {
    try {
      const {
        phone,
        otpCode,
        operadorNombre,
        operadorIne,
        operadorCurp,
        folioVal,
        originationId,
        consentSecundarias,
      } = req.body || {};

      if (!phone) return res.status(400).json({ message: "phone es obligatorio" });
      if (!otpCode) return res.status(400).json({ message: "otpCode es obligatorio" });

      // Verificar OTP con Twilio Verify (fail-loud si credenciales presentes)
      const otpResult = await checkOTP(String(phone), String(otpCode));
      if (!otpResult.valid) {
        return res.status(401).json({ message: "OTP inv\u00e1lido o vencido", otpStatus: otpResult.status });
      }

      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim() || null;
      const userAgent = String(req.headers["user-agent"] || "") || null;

      const result = await recordAcceptance({
        phone: String(phone),
        operadorNombre: operadorNombre || null,
        operadorIne: operadorIne || null,
        operadorCurp: operadorCurp || null,
        folioVal: folioVal || null,
        originationId: originationId ? parseInt(String(originationId), 10) : null,
        consentSecundarias: !!consentSecundarias,
        otpSid: otpResult.status || null, // Twilio Verify returns status as proof, no SID on check
        ipAceptacion: ip,
        userAgent,
      });

      await logAudit({
        action: "avp_accepted",
        actor: phone,
        role: "operador",
        target_type: "avp",
        target_id: result.folio,
        details: JSON.stringify({ version: result.version, consentSecundarias: !!consentSecundarias }),
        ip: ip || undefined,
      });

      res.json({
        ok: true,
        folio: result.folio,
        version: result.version,
        acceptedAt: result.acceptedAt,
        pdfBase64: result.pdfBase64,
      });
    } catch (e: any) {
      console.error("[AVP] POST accept failed:", e.message);
      res.status(500).json({ message: e.message });
    }
  });

  // POST: revoca el consentimiento (derecho ARCO - cancelación).
  app.post("/api/aviso-privacidad/revoke", async (req, res) => {
    try {
      const { phone } = req.body || {};
      if (!phone) return res.status(400).json({ message: "phone es obligatorio" });
      await revokeAcceptance(String(phone));
      await logAudit({
        action: "avp_revoked",
        actor: String(phone),
        role: "operador",
        target_type: "avp",
        target_id: String(phone),
      });
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[AVP] revoke failed:", e.message);
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/audit", async (req, res) => {
    try {
      const { action, actor, target_type, target_id, limit } = req.query;
      const logs = await getAuditLog({
        action: action as string,
        actor: actor as string,
        target_type: target_type as string,
        target_id: target_id as string,
        limit: limit ? parseInt(limit as string) : 100,
      });
      res.json({ success: true, logs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return httpServer;
}

// In-memory PDF cache (in production, use S3 or similar)
const pdfCache = new Map<number, { buffer: Buffer; folio: string; type: string }>();
// redeploy 1775833614
// cal-test 1775861116
// wake 1775995597
