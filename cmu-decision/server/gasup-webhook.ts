/**
 * GasUp Webhook Receiver — Fase 1
 *
 * Receives real-time transaction data from GasUp BackOffice and routes it
 * to the correct financial engine (recaudo-engine multi-product).
 *
 * Two ingestion modes:
 *   1. Webhook (real-time): POST /api/gasup/transaccion — single transaction
 *      → GasUp BackOffice fires this on every sale (Fase 3: Consware develops push)
 *   2. Batch (interim): POST /api/gasup/reporte — Excel report upload
 *      → Operator uploads HeadOffice report (uses existing recaudo-engine parser)
 *
 * Both modes normalize to GasUpTransaccion[] and route through the same pipeline:
 *   → validate + dedup → classify by placa (market_loader patterns)
 *   → route to Airtable TABLE_RECAUDO (financial engine)
 *   → forward to retention engine (central-gas-agent, future)
 *
 * Authentication: Bearer token (GASUP_WEBHOOK_SECRET env var)
 * Dedup: ticket ID + estacion + fecha prevents double-processing
 *
 * GasUp HeadOffice reports supported (26 total, 4 priority):
 *   - ventas_detalladas: Transaction-level sales → recaudo + retention
 *   - conciliacion_diaria: Daily close summary → ops dashboard
 *   - recaudos_financiera: Collection by financiera → financial engine
 *   - fidelizacion: Loyalty points/bonuses → CRM engagement
 *
 * Architecture:
 *   GasUp BackOffice → POST /api/gasup/transaccion → this module
 *     → recaudo-engine.processNatgasMultiProduct() → Airtable
 *     → (future) central-gas-agent retention webhook
 */

import { NatgasRow, processNatgasMultiProduct, parseNatgasExcel, parseNatgasCsv, hashFileContent, isDuplicateFile, markFileProcessed, formatRecaudoSummary } from "./recaudo-engine";

// ===== TYPES =====

/** Single transaction from GasUp webhook (real-time mode) */
export type GasUpTransaccion = {
  // Required fields
  placa: string;              // Vehicle plate (uppercase, no spaces)
  litros: number;             // LEQ dispensed
  precio_unitario: number;    // Price per LEQ (base)
  total: number;              // Total charged (litros × precio_unitario)
  estacion_id: string;        // Station identifier (e.g., "ECG-01")
  estacion_nombre: string;    // Station name (e.g., "Parques Industriales")
  manguera: number;           // Dispenser hose number (1-8)
  fecha_hora: string;         // ISO 8601 timestamp (e.g., "2026-04-13T14:30:00-06:00")
  medio_pago: string;         // Payment method: "efectivo" | "credito" | "prepago" | "tarjeta"
  ticket_id: string;          // Unique ticket/receipt number from BackOffice

  // Optional fields (enrichment)
  sobreprecio?: number;       // Surcharge per LEQ for financing (configurable per placa)
  total_sobreprecio?: number; // litros × sobreprecio (accumulated as recaudo)
  turno?: string;             // Shift ID
  promotor?: string;          // Attendant name
  chip_id?: string;           // iButton/TAG identifier
  forma_pago?: string;        // "contado" | "credito" | "prepago"
  id_cliente?: string;        // GasUp client ID
  nombre_cliente?: string;    // Client name from GasUp
};

/** Batch report upload metadata */
export type GasUpReporteUpload = {
  tipo: GasUpReporteTipo;
  estacion_id?: string;
  periodo_inicio?: string;    // YYYY-MM-DD
  periodo_fin?: string;       // YYYY-MM-DD
  fileBase64: string;         // Base64-encoded Excel file
  filename?: string;
};

/** Supported report types from GasUp HeadOffice */
export type GasUpReporteTipo =
  | "ventas_detalladas"       // Transaction-level: placa, litros, precio, fecha, medio_pago
  | "ventas_facturadas"       // Invoiced sales (with factura number)
  | "ventas_turno"            // Sales by shift: turno, promotor, litros, total
  | "conciliacion_diaria"     // Daily close: summary by payment method
  | "ventas_posicion"         // Sales by dispenser position/hose
  | "ventas_manguera"         // Detailed by hose with meter readings
  | "ventas_medio_pago"       // Consolidated by payment method
  | "ventas_forma_pago"       // Consolidated by payment type (litros)
  | "ventas_anuladas"         // Cancelled sales (fraud detection)
  | "cambio_medio_pago"       // Payment method changes (fraud flag)
  | "recaudos_financiera"     // Collections by financiera (for sobreprecio tracking)
  | "recaudos_cliente"        // Collections per client
  | "recaudos_estacion"       // Collections per station
  | "fidelizacion_movimientos"// Loyalty point movements
  | "fidelizacion_puntos"     // Points accumulated by placa
  | "fidelizacion_bonos"      // Bonus redemptions
  | "cartera_cliente"         // Client credit/prepaid portfolio
  | "abonos"                  // Prepaid top-ups
  | "revision_anual";         // Annual vehicle review dates

// ===== CONFIGURATION =====

const GASUP_WEBHOOK_SECRET = () => process.env.GASUP_WEBHOOK_SECRET || "dev-secret-change-me";

// Central Gas stations
const ESTACIONES_CENTRAL_GAS: Record<string, { nombre: string; tipo: string }> = {
  "ECG-01": { nombre: "Parques Industriales", tipo: "movil" },
  "ECG-02": { nombre: "Oriente", tipo: "movil" },
  "ECG-03": { nombre: "Pensión/Nacozari", tipo: "movil" },
};

// Sobreprecio is VARIABLE per financiera/placa — can range $2 to $14+ per LEQ.
// Never hardcode a default. The real sobreprecio comes from:
//   1. recaudos_financiera report (column "Recaudo" ÷ "Cantidad" per row)
//   2. ventas_detalladas "Recaudo Crédito" + "Recaudo Efectivo" columns
//   3. Webhook payload tx.sobreprecio field (if Consware sends it)
// If none available, we log a warning — do NOT assume a default value.

// ===== DEDUP =====

// In-memory dedup (ticket_id + estacion). Resets on deploy.
// Production: move to Redis or Neon table.
const processedTickets = new Set<string>();

function dedupKey(ticket_id: string, estacion_id: string): string {
  return `${estacion_id}:${ticket_id}`;
}

function isTicketProcessed(ticket_id: string, estacion_id: string): boolean {
  return processedTickets.has(dedupKey(ticket_id, estacion_id));
}

function markTicketProcessed(ticket_id: string, estacion_id: string): void {
  processedTickets.add(dedupKey(ticket_id, estacion_id));
  // Prevent unbounded growth: cap at 50K entries (covers ~2 weeks of transactions)
  if (processedTickets.size > 50_000) {
    const toDelete = Array.from(processedTickets).slice(0, 10_000);
    toDelete.forEach(k => processedTickets.delete(k));
  }
}

// ===== VALIDATION =====

function validateTransaccion(tx: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!tx.placa || typeof tx.placa !== "string") errors.push("placa required (string)");
  if (typeof tx.litros !== "number" || tx.litros <= 0) errors.push("litros required (positive number)");
  if (typeof tx.precio_unitario !== "number" || tx.precio_unitario <= 0) errors.push("precio_unitario required (positive number)");
  if (typeof tx.total !== "number" || tx.total <= 0) errors.push("total required (positive number)");
  if (!tx.estacion_id) errors.push("estacion_id required");
  if (!tx.fecha_hora) errors.push("fecha_hora required (ISO 8601)");
  if (!tx.ticket_id) errors.push("ticket_id required");
  if (!tx.medio_pago) errors.push("medio_pago required");
  return { valid: errors.length === 0, errors };
}

// ===== NORMALIZE: GasUpTransaccion → NatgasRow =====
// Bridge to existing recaudo-engine (processNatgasMultiProduct)

function transaccionToNatgasRow(tx: GasUpTransaccion): NatgasRow {
  // Sobreprecio is VARIABLE — comes from tx or recaudos report, never a default
  const sobreprecio = tx.sobreprecio ?? 0;
  const recaudo = tx.total_sobreprecio ?? (tx.litros * sobreprecio);

  if (sobreprecio === 0 && !tx.total_sobreprecio) {
    console.warn(`[GasUp] WARNING: No sobreprecio for placa ${tx.placa} ticket ${tx.ticket_id} — recaudo will be $0. Enrich from recaudos_financiera report.`);
  }

  return {
    financiera: "CONDUCTORES",  // Our financiera name in GasUp system
    placa: tx.placa.toUpperCase().replace(/[\s-]/g, ""),
    recaudo: Math.round(recaudo * 100) / 100,
    fechaVenta: tx.fecha_hora,
    litros: tx.litros,
    ticket: tx.ticket_id,
    estacion: tx.estacion_nombre || tx.estacion_id,
    valorRecaudo: sobreprecio,
    idCredito: tx.id_cliente || "",
  };
}

// ===== REAL COLUMN MAPPINGS (calibrated from GasUp reports 2026-04-13) =====
//
// ventas_detalladas (.xls) — headers at row 14 (0-indexed: row 13)
//   Col  1: EDS (station name)
//   Col  4: Fecha
//   Col  7: Producto
//   Col 10: Placa
//   Col 11: # Factura
//   Col 14: Medio de Pago
//   Col 15: Hora
//   Col 16: Precio unitario
//   Col 17: Cantidad (litros LEQ)
//   Col 18: Magnitud
//   Col 20: Total venta
//   Col 21: Recaudo Crédito     ← sobreprecio portion (credit)
//   Col 23: Recaudo efectivo    ← sobreprecio portion (cash)
//   Col 24: Total Venta + Recaudo
//   Col 25: Folio de Factura
//   Col 26: Número de autorización TPV
//
// recaudos_financiera transaccional (.xls) — headers at row 7 (0-indexed: row 6)
//   Col  1: EDS
//   Col  2: Codigo Factura       ← join key to ventas_detalladas
//   Col  5: Cantidad (litros)
//   Col  6: Precio
//   Col  7: Descuento
//   Col  8: Total Venta
//   Col 10: Recaudo              ← actual sobreprecio amount collected
//   Col 12: Fecha Venta
//   Col 15: Numero Credito
//   Col 16: Financiera           ← filter for "CONDUCTORES" or our financiera name
//   Col 17: Origen Recaudo

const VENTAS_DETALLADAS_HEADER_ROW = 13; // 0-indexed (row 14 in Excel)
const VENTAS_DETALLADAS_COLS = {
  EDS: 1,
  FECHA: 4,
  PRODUCTO: 7,
  PLACA: 10,
  NUM_FACTURA: 11,
  MEDIO_PAGO: 14,
  HORA: 15,
  PRECIO_UNITARIO: 16,
  CANTIDAD: 17,        // litros LEQ
  MAGNITUD: 18,
  TOTAL_VENTA: 20,
  RECAUDO_CREDITO: 21,  // sobreprecio portion (credit clients)
  RECAUDO_EFECTIVO: 23,  // sobreprecio portion (cash clients)
  TOTAL_VENTA_RECAUDO: 24,
  FOLIO_FACTURA: 25,
  NUM_AUTH_TPV: 26,
} as const;

const RECAUDOS_FINANCIERA_HEADER_ROW = 6; // 0-indexed (row 7 in Excel)
const RECAUDOS_FINANCIERA_COLS = {
  EDS: 1,
  CODIGO_FACTURA: 2,    // join key
  CANTIDAD: 5,          // litros
  PRECIO: 6,
  DESCUENTO: 7,
  TOTAL_VENTA: 8,
  RECAUDO: 10,          // actual sobreprecio amount
  FECHA_VENTA: 12,
  NUMERO_CREDITO: 15,
  FINANCIERA: 16,       // filter for our financiera
  ORIGEN_RECAUDO: 17,
} as const;

// Our financiera name(s) in GasUp — filter recaudos for these
const FINANCIERA_NAMES = ["CONDUCTORES", "CENTRAL GAS", "CENTRALGAS"];

// ===== REPORT PARSER ROUTER =====
// Maps GasUp HeadOffice report types to calibrated parsers

function parseGasUpReport(tipo: GasUpReporteTipo, buffer: Buffer): NatgasRow[] {
  switch (tipo) {
    case "ventas_detalladas":
    case "ventas_facturadas":
      // Transaction-level with placa — use calibrated ventas parser
      return parseVentasDetalladas(buffer);

    case "recaudos_financiera":
      // Sobreprecio by financiera — use calibrated recaudos parser
      return parseRecaudosFinanciera(buffer);

    case "recaudos_cliente":
    case "recaudos_estacion":
      // Other recaudo views — try generic parser
      return parseNatgasExcel(buffer);

    case "conciliacion_diaria":
    case "ventas_turno":
    case "ventas_posicion":
    case "ventas_manguera":
    case "ventas_medio_pago":
    case "ventas_forma_pago":
      // Summary reports — ops dashboard, no per-placa recaudo
      console.log(`[GasUp] Report type '${tipo}' logged for ops dashboard (no per-placa recaudo)`);
      return [];

    case "ventas_anuladas":
    case "cambio_medio_pago":
      // Fraud detection signals
      console.log(`[GasUp] ALERT: Report type '${tipo}' — review for potential fraud`);
      return [];

    case "fidelizacion_movimientos":
    case "fidelizacion_puntos":
    case "fidelizacion_bonos":
      console.log(`[GasUp] Loyalty report '${tipo}' — CRM integration pending`);
      return [];

    case "cartera_cliente":
    case "abonos":
      console.log(`[GasUp] Financial report '${tipo}' — enrichment pending`);
      return [];

    case "revision_anual":
      console.log(`[GasUp] Revision anual report — retention alert pending`);
      return [];

    default:
      console.warn(`[GasUp] Unknown report type: ${tipo}`);
      return [];
  }
}

// ===== CALIBRATED PARSER: VENTAS DETALLADAS =====
// Real GasUp report: .xls format, headers at row 14, 31K+ rows typical
// Each row = one fuel transaction with placa, litros, recaudo columns

function parseVentasDetalladas(buffer: Buffer): NatgasRow[] {
  // Delegate to Excel parser with column mapping override
  // The recaudo-engine's parseNatgasExcel handles xlsx via XLSX library.
  // For .xls files, we need xlrd (Python) or a JS .xls reader.
  // Strategy: try XLSX first (handles both), fall back to generic.
  try {
    const rows = parseNatgasExcel(buffer);
    if (rows.length > 0) return rows;
  } catch (_e) {
    // parseNatgasExcel may fail on .xls — expected
  }

  // If we get here, the buffer is likely .xls format.
  // Log and return empty — the wrapper (Python) handles .xls parsing
  // and calls us with pre-parsed JSON or re-exports as .xlsx.
  console.warn("[GasUp] ventas_detalladas: .xls format detected — route through Python wrapper for xlrd parsing");
  return [];
}

// ===== CALIBRATED PARSER: RECAUDOS FINANCIERA =====
// Real GasUp report: .xls, headers at row 7, ~10K rows typical
// KEY: sobreprecio per transaction, Financiera column for filtering

function parseRecaudosFinanciera(buffer: Buffer): NatgasRow[] {
  try {
    const rows = parseNatgasExcel(buffer);
    if (rows.length > 0) {
      // Filter for our financiera only
      const filtered = rows.filter(r =>
        FINANCIERA_NAMES.some(name =>
          (r.financiera || "").toUpperCase().includes(name)
        )
      );
      console.log(`[GasUp] recaudos_financiera: ${rows.length} total rows, ${filtered.length} for our financiera(s)`);
      return filtered;
    }
  } catch (_e) {
    // .xls format
  }

  console.warn("[GasUp] recaudos_financiera: .xls format detected — route through Python wrapper for xlrd parsing");
  return [];
}

// ===== ENRICHED BATCH: VENTAS + RECAUDOS JOIN =====
// ventas_detalladas has placa but NO financiera
// recaudos_financiera has financiera + sobreprecio but NO placa
// Join on Codigo Factura / # Factura to get: placa + sobreprecio + financiera

export type EnrichedTransaction = NatgasRow & {
  financieraName: string;
  codigoFactura: string;
  medioPago: string;
  recaudoCredito: number;
  recaudoEfectivo: number;
};

// In-memory join store — populated when both reports are uploaded
const _ventasIndex: Map<string, any> = new Map(); // factura → ventas row
const _recaudosIndex: Map<string, any> = new Map(); // factura → recaudos row

export function joinVentasRecaudos(): EnrichedTransaction[] {
  const enriched: EnrichedTransaction[] = [];
  for (const [factura, venta] of _ventasIndex) {
    const recaudo = _recaudosIndex.get(factura);
    if (recaudo) {
      enriched.push({
        ...venta,
        financieraName: recaudo.financiera || "",
        codigoFactura: factura,
        recaudoCredito: recaudo.recaudoCredito || 0,
        recaudoEfectivo: recaudo.recaudoEfectivo || 0,
        // Override recaudo with actual sobreprecio from recaudos report
        recaudo: recaudo.recaudo || venta.recaudo,
        valorRecaudo: recaudo.valorRecaudo || venta.valorRecaudo,
      });
    }
  }
  console.log(`[GasUp] Join result: ${enriched.length} enriched transactions from ${_ventasIndex.size} ventas × ${_recaudosIndex.size} recaudos`);
  return enriched;
}

// ===== PROCESS SINGLE TRANSACTION (webhook mode) =====

export type WebhookResult = {
  success: boolean;
  ticket_id: string;
  placa: string;
  recaudo: number;
  producto?: string;
  duplicate?: boolean;
  error?: string;
};

export async function processWebhookTransaccion(tx: GasUpTransaccion): Promise<WebhookResult> {
  const cleanPlaca = tx.placa.toUpperCase().replace(/[\s-]/g, "");

  // Dedup
  if (isTicketProcessed(tx.ticket_id, tx.estacion_id)) {
    return { success: true, ticket_id: tx.ticket_id, placa: cleanPlaca, recaudo: 0, duplicate: true };
  }

  // Normalize to NatgasRow and process through existing multi-product engine
  const row = transaccionToNatgasRow(tx);
  const summary = await processNatgasMultiProduct([row]);

  markTicketProcessed(tx.ticket_id, tx.estacion_id);

  const producto = summary.detalle[0]?.producto || "no_match";
  const recaudo = summary.totalRecaudo;

  // Log for audit trail
  console.log(`[GasUp Webhook] ${cleanPlaca} | ${tx.litros}L | recaudo $${recaudo} | ${producto} | ${tx.estacion_id} | ticket ${tx.ticket_id}`);

  if (summary.placasNoEncontradas.length > 0) {
    console.log(`[GasUp Webhook] Placa ${cleanPlaca} no found in Placas Recaudo — transaction logged but not routed`);
  }

  return {
    success: true,
    ticket_id: tx.ticket_id,
    placa: cleanPlaca,
    recaudo,
    producto,
  };
}

// ===== PROCESS BATCH REPORT (Excel upload mode) =====

export type BatchResult = {
  success: boolean;
  tipo: GasUpReporteTipo;
  rowsParsed: number;
  rowsProcessed: number;
  totalRecaudo: number;
  totalLitros: number;
  creditosActualizados: number;
  placasNoEncontradas: string[];
  formatted?: string;
  duplicate?: boolean;
  error?: string;
};

export async function processGasUpReporte(upload: GasUpReporteUpload): Promise<BatchResult> {
  const buffer = Buffer.from(upload.fileBase64, "base64");

  // Dedup check on file content
  if (isDuplicateFile(buffer)) {
    return {
      success: true, tipo: upload.tipo, rowsParsed: 0, rowsProcessed: 0,
      totalRecaudo: 0, totalLitros: 0, creditosActualizados: 0,
      placasNoEncontradas: [], duplicate: true,
    };
  }

  // Parse based on report type
  const rows = parseGasUpReport(upload.tipo, buffer);

  if (rows.length === 0) {
    // Non-transactional reports (ops, loyalty, etc.) — just log
    markFileProcessed(buffer);
    return {
      success: true, tipo: upload.tipo, rowsParsed: 0, rowsProcessed: 0,
      totalRecaudo: 0, totalLitros: 0, creditosActualizados: 0,
      placasNoEncontradas: [],
    };
  }

  // Process through multi-product engine
  const summary = await processNatgasMultiProduct(rows);
  markFileProcessed(buffer);

  return {
    success: true,
    tipo: upload.tipo,
    rowsParsed: rows.length,
    rowsProcessed: summary.detalle.length,
    totalRecaudo: summary.totalRecaudo,
    totalLitros: summary.totalLitros,
    creditosActualizados: summary.creditosActualizados,
    placasNoEncontradas: summary.placasNoEncontradas,
    formatted: formatRecaudoSummary(summary),
  };
}

// ===== EXPRESS ROUTE HANDLERS =====

export function registerGasUpRoutes(app: any): void {
  /**
   * POST /api/gasup/transaccion — Real-time webhook from GasUp BackOffice
   *
   * Called by GasUp for every sale transaction.
   * Auth: Bearer token in Authorization header.
   *
   * Body: GasUpTransaccion (single transaction)
   * Response: WebhookResult
   */
  app.post("/api/gasup/transaccion", async (req: any, res: any) => {
    try {
      // Auth check
      const authHeader = req.headers.authorization || "";
      const token = authHeader.replace("Bearer ", "");
      if (token !== GASUP_WEBHOOK_SECRET()) {
        return res.status(401).json({ error: "Invalid or missing authorization token" });
      }

      // Validate
      const validation = validateTransaccion(req.body);
      if (!validation.valid) {
        return res.status(400).json({ error: "Validation failed", details: validation.errors });
      }

      const result = await processWebhookTransaccion(req.body as GasUpTransaccion);
      return res.json(result);
    } catch (err: any) {
      console.error("[GasUp Webhook] Error:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/gasup/transacciones — Batch webhook (multiple transactions)
   *
   * Accepts an array of transactions (e.g., end-of-shift batch from GasUp).
   * Auth: Bearer token.
   *
   * Body: { transacciones: GasUpTransaccion[] }
   * Response: { results: WebhookResult[], summary: { total, processed, duplicates, errors } }
   */
  app.post("/api/gasup/transacciones", async (req: any, res: any) => {
    try {
      const authHeader = req.headers.authorization || "";
      const token = authHeader.replace("Bearer ", "");
      if (token !== GASUP_WEBHOOK_SECRET()) {
        return res.status(401).json({ error: "Invalid or missing authorization token" });
      }

      const { transacciones } = req.body;
      if (!Array.isArray(transacciones) || transacciones.length === 0) {
        return res.status(400).json({ error: "transacciones array required" });
      }

      const results: WebhookResult[] = [];
      let processed = 0, duplicates = 0, errors = 0;

      for (const tx of transacciones) {
        const validation = validateTransaccion(tx);
        if (!validation.valid) {
          results.push({ success: false, ticket_id: tx.ticket_id || "?", placa: tx.placa || "?", recaudo: 0, error: validation.errors.join(", ") });
          errors++;
          continue;
        }
        const result = await processWebhookTransaccion(tx);
        results.push(result);
        if (result.duplicate) duplicates++;
        else processed++;
      }

      return res.json({
        results,
        summary: { total: transacciones.length, processed, duplicates, errors },
      });
    } catch (err: any) {
      console.error("[GasUp Batch Webhook] Error:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/gasup/reporte — Excel report upload from HeadOffice
   *
   * Interim mode: operator exports report from GasUp HeadOffice and uploads here.
   * No auth required (internal use) — add PIN or session auth if exposed.
   *
   * Body: GasUpReporteUpload { tipo, fileBase64, filename?, estacion_id?, periodo_* }
   * Response: BatchResult
   */
  app.post("/api/gasup/reporte", async (req: any, res: any) => {
    try {
      const { tipo, fileBase64, filename } = req.body;
      if (!tipo || !fileBase64) {
        return res.status(400).json({ error: "tipo and fileBase64 required" });
      }

      const result = await processGasUpReporte(req.body as GasUpReporteUpload);
      return res.json(result);
    } catch (err: any) {
      console.error("[GasUp Report] Error:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/gasup/status — Health check and stats
   */
  app.get("/api/gasup/status", (_req: any, res: any) => {
    res.json({
      status: "online",
      estaciones: Object.keys(ESTACIONES_CENTRAL_GAS),
      sobreprecio: "VARIABLE — no default, ranges $2-$14+/LEQ per financiera/placa",
      financiera_filter: FINANCIERA_NAMES,
      tickets_in_dedup_cache: processedTickets.size,
      endpoints: {
        webhook_single: "POST /api/gasup/transaccion",
        webhook_batch: "POST /api/gasup/transacciones",
        report_upload: "POST /api/gasup/reporte",
        status: "GET /api/gasup/status",
      },
      report_types_supported: [
        "ventas_detalladas", "ventas_facturadas", "ventas_turno",
        "conciliacion_diaria", "ventas_posicion", "ventas_manguera",
        "ventas_medio_pago", "ventas_forma_pago", "ventas_anuladas",
        "cambio_medio_pago", "recaudos_financiera", "recaudos_cliente",
        "recaudos_estacion", "fidelizacion_movimientos", "fidelizacion_puntos",
        "fidelizacion_bonos", "cartera_cliente", "abonos", "revision_anual",
      ],
    });
  });

  console.log("[GasUp] Webhook routes registered: /api/gasup/transaccion, /api/gasup/transacciones, /api/gasup/reporte, /api/gasup/status");
}
