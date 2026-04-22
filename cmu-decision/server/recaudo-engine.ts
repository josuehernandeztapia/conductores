/**
 * Recaudo Engine v2 — Multi-Producto
 * 
 * Supports 3 CMU products:
 *   1. Taxi Renovación (Crédito a plazos, 36 meses) — table: Creditos
 *   2. Joylong Ahorro Individual (Promesa de compraventa, sin plazo fijo) — table: Ahorro Joylong
 *   3. Kit Conversión GNV (Compraventa a plazos, 12 meses) — table: Kit Conversion
 * 
 * Lookup flow:
 *   NATGAS Excel row → placa → Placas Recaudo (lookup table) → route to product table
 * 
 * CSV/Excel format (NATGAS):
 *   Financiera | Placa | Cantidad de Recaudo | Fecha y hora de Venta | Litros de Venta | Ticket | Estacion | Turno inicio | Fecha de venta | Valor recaudo | id_placa_recaudo | id_credito
 */

import * as XLSX from "xlsx";
import { createHash } from "crypto";
import { neon } from "@neondatabase/serverless";

const AIRTABLE_PAT = () => process.env.AIRTABLE_PAT || "";
const AIRTABLE_BASE = "appXxbjjGzXFiX7gk";

// ===== DEDUP: Persistent in Neon DB =====
// Table: processed_files (sha256 TEXT PRIMARY KEY, filename TEXT, processed_at TIMESTAMPTZ)

function getSQL() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;
  return neon(dbUrl);
}

async function ensureDedupTable() {
  const sql = getSQL();
  if (!sql) return;
  await sql`CREATE TABLE IF NOT EXISTS processed_files (
    sha256 TEXT PRIMARY KEY,
    filename TEXT,
    processed_at TIMESTAMPTZ DEFAULT NOW()
  )`;
}

// In-memory fallback for when DB is unavailable
const memoryHashes = new Set<string>();

/** Compute SHA-256 hash of file content */
export function hashFileContent(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Check if file was already processed (DB + memory). Returns true if duplicate. */
export async function isDuplicateFile(content: Buffer | string): Promise<boolean> {
  const hash = hashFileContent(content);
  if (memoryHashes.has(hash)) return true;
  try {
    const sql = getSQL();
    if (sql) {
      await ensureDedupTable();
      const rows = await sql`SELECT 1 FROM processed_files WHERE sha256 = ${hash}`;
      if (rows.length > 0) {
        memoryHashes.add(hash);
        return true;
      }
    }
  } catch (e: any) {
    console.warn(`[Dedup] DB check failed: ${e.message}`);
  }
  return false;
}

/** Mark file as processed (DB + memory) */
export async function markFileProcessed(content: Buffer | string, filename?: string): Promise<void> {
  const hash = hashFileContent(content);
  memoryHashes.add(hash);
  try {
    const sql = getSQL();
    if (sql) {
      await ensureDedupTable();
      await sql`INSERT INTO processed_files (sha256, filename) VALUES (${hash}, ${filename || 'unknown'}) ON CONFLICT (sha256) DO NOTHING`;
      console.log(`[Dedup] Stored hash ${hash} for ${filename || 'unknown'} in DB`);
    }
  } catch (e: any) {
    console.warn(`[Dedup] DB store failed: ${e.message}`);
  }
}

// Table IDs
const TABLE_CREDITOS = "tblA62WNhSb4xYfYv";        // Taxi Renovación (legacy)
const TABLE_PAGOS = "tbl5RiGyVgeE4EVfE";            // Pagos (all products)
const TABLE_RECAUDO = "tblSUWmIE8Ma5be9u";           // RecaudoGNV (weekly tracking)
const TABLE_AHORRO_JOYLONG = "tblUjkOQ2rWvBRRmw";   // Joylong Ahorro Individual
const TABLE_KIT_CONVERSION = "tbletXmlYRwisBcaO";    // Kit Conversión GNV
const TABLE_PLACAS = "tblb4cdo0wv3qeWxs";            // Placas Recaudo (lookup)

// ===== PARSER (CSV + Excel) =====

export type NatgasRow = {
  financiera: string;
  placa: string;
  recaudo: number;
  fechaVenta: string;
  litros: number;
  ticket: string;
  estacion: string;
  valorRecaudo: number; // precio por LEQ
  idCredito: string; // nombre del titular o ID
};

/**
 * Parse NATGAS Excel (.xlsx) buffer into structured rows.
 * Real format: Row 1 = title, Row 3 = headers, Row 4+ = data.
 */
export function parseNatgasExcel(buffer: Buffer): NatgasRow[] {
  if (!buffer || buffer.length < 10) {
    console.error(`[Recaudo] parseNatgasExcel: buffer too small (${buffer?.length || 0} bytes)`);
    return [];
  }
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer" });
  } catch (e: any) {
    console.error(`[Recaudo] parseNatgasExcel: XLSX.read failed: ${e.message}`);
    return [];
  }
  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    console.error(`[Recaudo] parseNatgasExcel: No sheets found in workbook`);
    return [];
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) {
    console.error(`[Recaudo] parseNatgasExcel: Sheet '${wb.SheetNames[0]}' is empty`);
    return [];
  }
  const allRows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

  // Find the header row (contains "Placa" and "Financiera")
  let headerIdx = -1;
  for (let i = 0; i < Math.min(10, allRows.length); i++) {
    const row = allRows[i].map((c: any) => String(c || "").toLowerCase());
    if (row.some((c: string) => c.includes("placa")) && row.some((c: string) => c.includes("financiera"))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const headers = allRows[headerIdx].map((h: any) => String(h || "").toLowerCase().trim());
  const colMap: Record<string, number> = {};
  headers.forEach((h: string, i: number) => {
    if (h.includes("financiera")) colMap.financiera = i;
    if (h.includes("placa") && !h.includes("id_placa")) colMap.placa = i;
    if (h.includes("cantidad") && h.includes("recaudo")) colMap.recaudo = i;
    if (h.includes("fecha") && h.includes("hora")) colMap.fechaVenta = i;
    if (h === "fecha de venta") colMap.fechaCorta = i;
    if (h.includes("litros")) colMap.litros = i;
    if (h.includes("ticket")) colMap.ticket = i;
    if (h.includes("estacion")) colMap.estacion = i;
    if (h === "valor recaudo") colMap.valorRecaudo = i;
    if (h === "id_credito") colMap.idCredito = i;
  });

  const rows: NatgasRow[] = [];
  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const cols = allRows[i];
    if (!cols || cols.length < 3) continue;
    const financiera = String(cols[colMap.financiera ?? 0] || "");
    if (!financiera.toUpperCase().includes("CONDUCTORES")) continue;

    rows.push({
      financiera,
      placa: String(cols[colMap.placa ?? 1] || "").toUpperCase().replace(/\s/g, ""),
      recaudo: parseFloat(String(cols[colMap.recaudo ?? 2] || "0")) || 0,
      fechaVenta: String(cols[colMap.fechaVenta ?? 3] || cols[colMap.fechaCorta ?? 3] || ""),
      litros: parseFloat(String(cols[colMap.litros ?? 4] || "0")) || 0,
      ticket: String(cols[colMap.ticket ?? 5] || ""),
      estacion: String(cols[colMap.estacion ?? 6] || ""),
      valorRecaudo: parseFloat(String(cols[colMap.valorRecaudo ?? 0] || "11")) || 11,
      idCredito: String(cols[colMap.idCredito ?? 0] || ""),
    });
  }

  return rows;
}

/**
 * Parse NATGAS CSV content into structured rows.
 */
export function parseNatgasCsv(csvContent: string): NatgasRow[] {
  const lines = csvContent.trim().split("\n").filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    if (lines[i].toLowerCase().includes("placa")) { headerIdx = i; break; }
  }

  const header = lines[headerIdx];
  const delimiter = header.includes("\t") ? "\t" : header.includes(";") ? ";" : ",";
  const headers = header.split(delimiter).map(h => h.trim().toLowerCase().replace(/[^a-z0-9 ]/g, ""));

  const colMap: Record<string, number> = {};
  headers.forEach((h, i) => {
    if (h.includes("financiera")) colMap.financiera = i;
    if (h.includes("placa") && !h.includes("id")) colMap.placa = i;
    if (h.includes("recaudo") && h.includes("cantidad")) colMap.recaudo = i;
    if (h.includes("fecha") && h.includes("venta")) colMap.fechaVenta = i;
    if (h.includes("litros")) colMap.litros = i;
    if (h.includes("ticket")) colMap.ticket = i;
    if (h.includes("estacion")) colMap.estacion = i;
    if (h === "valor recaudo") colMap.valorRecaudo = i;
    if (h.includes("id") && h.includes("credito")) colMap.idCredito = i;
  });

  const rows: NatgasRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = lines[i].split(delimiter).map(c => c.trim());
    if (cols.length < 3) continue;
    const financiera = cols[colMap.financiera ?? 0] || "";
    if (!financiera.toUpperCase().includes("CONDUCTORES")) continue;

    rows.push({
      financiera,
      placa: (cols[colMap.placa ?? 1] || "").toUpperCase().replace(/\s/g, ""),
      recaudo: parseFloat(cols[colMap.recaudo ?? 2] || "0") || 0,
      fechaVenta: cols[colMap.fechaVenta ?? 3] || "",
      litros: parseFloat(cols[colMap.litros ?? 4] || "0") || 0,
      ticket: cols[colMap.ticket ?? 5] || "",
      estacion: cols[colMap.estacion ?? 6] || "",
      valorRecaudo: parseFloat(cols[colMap.valorRecaudo ?? 0] || "11") || 11,
      idCredito: cols[colMap.idCredito ?? 0] || "",
    });
  }

  return rows;
}

/**
 * Parse either CSV text or Excel buffer
 */
export function parseNatgasFile(content: string | Buffer, isExcel: boolean): NatgasRow[] {
  if (isExcel && Buffer.isBuffer(content)) return parseNatgasExcel(content);
  return parseNatgasCsv(typeof content === "string" ? content : content.toString("utf-8"));
}

// ===== AIRTABLE HELPERS =====

async function airtableFetch(tableId: string, params: Record<string, string> = {}): Promise<any[]> {
  const token = AIRTABLE_PAT();
  if (!token) return [];
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}${qs ? "?" + qs : ""}`;
  const res = await fetch(url, { headers: { "Authorization": `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) { console.error(`[Recaudo] Airtable error ${res.status}`); return []; }
  const data = await res.json();
  return (data.records || []).map((r: any) => ({ _id: r.id, ...r.fields }));
}

async function airtableCreate(tableId: string, fields: Record<string, any>): Promise<any> {
  const token = AIRTABLE_PAT();
  if (!token) return null;
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }] }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  return data.records?.[0] || null;
}

async function airtableUpdate(tableId: string, recordId: string, fields: Record<string, any>): Promise<void> {
  const token = AIRTABLE_PAT();
  if (!token) return;
  await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}/${recordId}`, {
    method: "PATCH",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
    signal: AbortSignal.timeout(10000),
  });
}

// ===== MULTI-PRODUCT RECAUDO SUMMARY =====

export type ProductDetalle = {
  placa: string;
  folio: string;
  cliente: string;
  producto: string;
  recaudo: number;
  litros: number;
};

export type RecaudoSummary = {
  totalRows: number;
  totalRecaudo: number;
  totalLitros: number;
  creditosActualizados: number;
  placasNoEncontradas: string[];
  detalle: ProductDetalle[];
  periodo: string;
  // Per-product breakdowns
  joylong: { contratos: number; recaudo: number; detalle: ProductDetalle[] };
  kitConversion: { contratos: number; recaudo: number; detalle: ProductDetalle[] };
  taxiRenovacion: { contratos: number; recaudo: number; detalle: ProductDetalle[] };
};

/**
 * Process NATGAS data (CSV or Excel): multi-product routing via Placas Recaudo table.
 * 
 * Flow:
 * 1. Load all active placas from Placas Recaudo table
 * 2. For each placa in NATGAS data, find the matching record
 * 3. Route to the correct product handler:
 *    - "Taxi Renovación" → update Creditos + Pagos + RecaudoGNV (legacy flow)
 *    - "Joylong Ahorro" → accumulate in Ahorro Joylong table
 *    - "Kit Conversión" → apply to Kit Conversion table (similar to taxi but simpler)
 * 4. For unmatched placas, also try legacy Creditos table (backward compat)
 */
export async function processNatgasMultiProduct(rows: NatgasRow[]): Promise<RecaudoSummary> {
  if (rows.length === 0) {
    return {
      totalRows: 0, totalRecaudo: 0, totalLitros: 0, creditosActualizados: 0,
      placasNoEncontradas: [], detalle: [], periodo: "",
      joylong: { contratos: 0, recaudo: 0, detalle: [] },
      kitConversion: { contratos: 0, recaudo: 0, detalle: [] },
      taxiRenovacion: { contratos: 0, recaudo: 0, detalle: [] },
    };
  }

  // 1. Load all active placas from lookup table
  const placasRecords = await airtableFetch(TABLE_PLACAS, {
    filterByFormula: `{Activa}=TRUE()`,
  });
  const placaMap = new Map<string, any>();
  for (const p of placasRecords) {
    if (p.Placa) placaMap.set(p.Placa.toUpperCase().replace(/\s/g, ""), p);
  }

  // 2. Also load legacy Creditos for backward compatibility (taxi product)
  const creditos = await airtableFetch(TABLE_CREDITOS, {
    filterByFormula: `OR({Estatus}="Activo",{Estatus}="Mora Leve")`,
  });
  const placaToCredito = new Map<string, any>();
  for (const c of creditos) {
    if (c.Placas) placaToCredito.set(c.Placas.toUpperCase().replace(/\s/g, ""), c);
  }

  // 3. Aggregate by placa
  const aggregated = new Map<string, { recaudo: number; litros: number; tickets: string[]; fechaMin: string; fechaMax: string }>();
  for (const row of rows) {
    const existing = aggregated.get(row.placa) || { recaudo: 0, litros: 0, tickets: [], fechaMin: row.fechaVenta, fechaMax: row.fechaVenta };
    existing.recaudo += row.recaudo;
    existing.litros += row.litros;
    existing.tickets.push(row.ticket);
    if (row.fechaVenta < existing.fechaMin) existing.fechaMin = row.fechaVenta;
    if (row.fechaVenta > existing.fechaMax) existing.fechaMax = row.fechaVenta;
    aggregated.set(row.placa, existing);
  }

  // Determine periodo
  const allDates = rows.map(r => r.fechaVenta.slice(0, 10)).sort();
  const periodo = allDates.length > 0 ? `${allDates[0]} a ${allDates[allDates.length - 1]}` : "?";

  const placasNoEncontradas: string[] = [];
  const detalle: ProductDetalle[] = [];
  let creditosActualizados = 0;

  const joylongDetalle: ProductDetalle[] = [];
  const kitDetalle: ProductDetalle[] = [];
  const taxiDetalle: ProductDetalle[] = [];

  // Track folios already processed (aggregate multiple placas per folio for Joylong)
  const joylongByFolio = new Map<string, { recaudo: number; litros: number; cliente: string; placas: string[] }>();
  const kitByFolio = new Map<string, { recaudo: number; litros: number; cliente: string; placas: string[] }>();

  for (const [placa, agg] of aggregated) {
    const placaRecord = placaMap.get(placa);

    if (placaRecord) {
      const producto = placaRecord.Producto;
      const folio = placaRecord.Folio;
      const cliente = placaRecord.Cliente;

      if (producto === "Joylong Ahorro") {
        // Accumulate by folio (a client can have multiple placas)
        const existing = joylongByFolio.get(folio) || { recaudo: 0, litros: 0, cliente, placas: [] as string[] };
        existing.recaudo += agg.recaudo;
        existing.litros += agg.litros;
        existing.placas.push(placa);
        joylongByFolio.set(folio, existing);

        detalle.push({ placa, folio, cliente, producto: "Joylong Ahorro", recaudo: Math.round(agg.recaudo), litros: Math.round(agg.litros) });

      } else if (producto === "Kit Conversión") {
        const existing = kitByFolio.get(folio) || { recaudo: 0, litros: 0, cliente, placas: [] as string[] };
        existing.recaudo += agg.recaudo;
        existing.litros += agg.litros;
        existing.placas.push(placa);
        kitByFolio.set(folio, existing);

        detalle.push({ placa, folio, cliente, producto: "Kit Conversión", recaudo: Math.round(agg.recaudo), litros: Math.round(agg.litros) });

      } else if (producto === "Taxi Renovación") {
        // Use legacy Creditos flow
        const credito = placaToCredito.get(placa);
        if (credito) {
          await processTaxiRecaudo(credito, agg, periodo);
          taxiDetalle.push({ placa, folio: credito.Folio, cliente: credito.Taxista, producto: "Taxi Renovación", recaudo: Math.round(agg.recaudo), litros: Math.round(agg.litros) });
          detalle.push({ placa, folio: credito.Folio, cliente: credito.Taxista, producto: "Taxi Renovación", recaudo: Math.round(agg.recaudo), litros: Math.round(agg.litros) });
          creditosActualizados++;
        }
      }
    } else {
      // Fallback: try legacy Creditos table directly (backward compat)
      const credito = placaToCredito.get(placa);
      if (credito) {
        await processTaxiRecaudo(credito, agg, periodo);
        taxiDetalle.push({ placa, folio: credito.Folio, cliente: credito.Taxista, producto: "Taxi Renovación", recaudo: Math.round(agg.recaudo), litros: Math.round(agg.litros) });
        detalle.push({ placa, folio: credito.Folio, cliente: credito.Taxista, producto: "Taxi Renovación", recaudo: Math.round(agg.recaudo), litros: Math.round(agg.litros) });
        creditosActualizados++;
      } else {
        placasNoEncontradas.push(`${placa} ($${Math.round(agg.recaudo).toLocaleString()}, ${Math.round(agg.litros)} LEQ)`);
      }
    }
  }

  // 4. Process Joylong ahorro: create Pago record + RECONCILE from all Pagos
  for (const [folio, data] of joylongByFolio) {
    // Create Pago record (auditable, like Kit Conversión)
    await airtableCreate(TABLE_PAGOS, {
      "Folio": folio,
      "Mes": 0,
      "Concepto": "Recaudo GNV",
      "Monto": Math.round(data.recaudo),
      "Método": "Recaudo GNV (NATGAS)",
      "Estatus": "Confirmado",
      "Fecha Pago": new Date().toISOString().slice(0, 10),
      "Notas": `Joylong | ${data.litros.toFixed(0)} LEQ | ${periodo} | Placas: ${data.placas.join(", ")}`,
    });

    // RECONCILE: recalculate Ahorro Acumulado from ALL Pagos for this folio
    const allPagos = await airtableFetch(TABLE_PAGOS, {
      filterByFormula: `AND({Folio}="${folio}",{Estatus}="Confirmado",{Concepto}="Recaudo GNV")`,
    });
    const totalFromPagos = allPagos.reduce((sum: number, p: any) => sum + (p.Monto || 0), 0);

    const records = await airtableFetch(TABLE_AHORRO_JOYLONG, {
      filterByFormula: `{Folio}="${folio}"`,
      maxRecords: "1",
    });
    if (records.length > 0) {
      const record = records[0];
      const prevAhorro = record["Ahorro Acumulado"] || 0;
      const precioVehiculo = record["Precio Vehiculo"] || 799000;
      const pctAvance = totalFromPagos / precioVehiculo;
      const nuevoEstatus = totalFromPagos >= (record.Gatillo || 399500) ? "Gatillo Alcanzado" : "Ahorrando";

      // Log reconciliation delta
      if (Math.abs(totalFromPagos - prevAhorro - Math.round(data.recaudo)) > 10) {
        console.warn(`[Recaudo] RECONCILE ${folio}: prev=${prevAhorro} + new=${Math.round(data.recaudo)} = ${prevAhorro + Math.round(data.recaudo)}, but sum(Pagos)=${totalFromPagos}`);
      }

      await airtableUpdate(TABLE_AHORRO_JOYLONG, record._id, {
        "Ahorro Acumulado": totalFromPagos,
        "Pct Avance": pctAvance,
        "Estatus": nuevoEstatus,
      });
      creditosActualizados++;
    }

    joylongDetalle.push({
      placa: data.placas.join(", "),
      folio,
      cliente: data.cliente,
      producto: "Joylong Ahorro",
      recaudo: Math.round(data.recaudo),
      litros: Math.round(data.litros),
    });
  }

  // 5. Process Kit Conversión: create Pago + RECONCILE Saldo from all Pagos
  for (const [folio, data] of kitByFolio) {
    const records = await airtableFetch(TABLE_KIT_CONVERSION, {
      filterByFormula: `{Folio}="${folio}"`,
      maxRecords: "1",
    });
    if (records.length > 0) {
      const record = records[0];
      const mesActual = record["Mes Actual"] || 1;

      // Create Pago record
      await airtableCreate(TABLE_PAGOS, {
        "Folio": folio,
        "Mes": mesActual,
        "Concepto": "Recaudo GNV",
        "Monto": Math.round(data.recaudo),
        "Método": "Recaudo GNV (NATGAS)",
        "Estatus": "Confirmado",
        "Fecha Pago": new Date().toISOString().slice(0, 10),
        "Notas": `Kit Conv | ${data.litros.toFixed(0)} LEQ | ${periodo} | Placas: ${data.placas.join(", ")}`,
      });

      // RECONCILE: recalculate Saldo Pendiente from ALL Pagos
      const allPagos = await airtableFetch(TABLE_PAGOS, {
        filterByFormula: `AND({Folio}="${folio}",{Estatus}="Confirmado",{Concepto}="Recaudo GNV")`,
      });
      const totalPagado = allPagos.reduce((sum: number, p: any) => sum + (p.Monto || 0), 0);
      const precioKit = record["Precio Kit"] || 55500;
      const saldoPendiente = Math.max(0, precioKit - totalPagado);

      await airtableUpdate(TABLE_KIT_CONVERSION, record._id, {
        "Saldo Pendiente": saldoPendiente,
      });

      creditosActualizados++;
    }

    kitDetalle.push({
      placa: data.placas.join(", "),
      folio,
      cliente: data.cliente,
      producto: "Kit Conversión",
      recaudo: Math.round(data.recaudo),
      litros: Math.round(data.litros),
    });
  }

  return {
    totalRows: rows.length,
    totalRecaudo: Math.round(rows.reduce((s, r) => s + r.recaudo, 0)),
    totalLitros: Math.round(rows.reduce((s, r) => s + r.litros, 0)),
    creditosActualizados,
    placasNoEncontradas,
    detalle,
    periodo,
    joylong: { contratos: joylongByFolio.size, recaudo: Math.round([...joylongByFolio.values()].reduce((s, d) => s + d.recaudo, 0)), detalle: joylongDetalle },
    kitConversion: { contratos: kitByFolio.size, recaudo: Math.round([...kitByFolio.values()].reduce((s, d) => s + d.recaudo, 0)), detalle: kitDetalle },
    taxiRenovacion: { contratos: taxiDetalle.length, recaudo: Math.round(taxiDetalle.reduce((s, d) => s + d.recaudo, 0)), detalle: taxiDetalle },
  };
}

/**
 * Legacy taxi recaudo processing (Creditos + Pagos + RecaudoGNV)
 */
async function processTaxiRecaudo(credito: any, agg: { recaudo: number; litros: number; tickets: string[] }, periodo: string) {
  // Create Pago record
  await airtableCreate(TABLE_PAGOS, {
    "Folio": credito.Folio,
    "Mes": credito["Mes Actual"] || 0,
    "Concepto": "Recaudo GNV",
    "Monto": Math.round(agg.recaudo),
    "Método": "Recaudo GNV (NATGAS)",
    "Estatus": "Confirmado",
    "Fecha Pago": new Date().toISOString().slice(0, 10),
    "Referencia": agg.tickets.slice(0, 3).join(", "),
    "Notas": `${agg.litros.toFixed(1)} LEQ | ${periodo} | ${agg.tickets.length} cargas`,
  });

  // Create/Update RecaudoGNV record
  const mesActual = credito["Mes Actual"] || 0;
  const existingRecaudo = await airtableFetch(TABLE_RECAUDO, {
    filterByFormula: `AND({Folio}="${credito.Folio}",{Mes}=${mesActual})`,
    maxRecords: "1",
  });

  if (existingRecaudo.length > 0) {
    const existing = existingRecaudo[0];
    await airtableUpdate(TABLE_RECAUDO, existing._id, {
      "LEQ": (existing.LEQ || 0) + Math.round(agg.litros),
      "Recaudo": (existing.Recaudo || 0) + Math.round(agg.recaudo),
    });
  } else {
    await airtableCreate(TABLE_RECAUDO, {
      "Folio": credito.Folio,
      "Mes": mesActual,
      "Periodo": periodo,
      "LEQ": Math.round(agg.litros),
      "Recaudo": Math.round(agg.recaudo),
      "Cuota": credito["Cuota Actual"] || 0,
      "Diferencial": Math.max(0, (credito["Cuota Actual"] || 0) - Math.round(agg.recaudo)),
    });
  }
}

/**
 * Legacy CSV-only wrapper (backward compat for WhatsApp agent)
 */
export async function processNatgasCsv(csvContent: string): Promise<RecaudoSummary> {
  const rows = parseNatgasCsv(csvContent);
  return processNatgasMultiProduct(rows);
}

// ===== MONTHLY CLOSE (called by cron on day 1) =====

export type CierreResult = {
  creditosProcesados: number;
  gnvCubrio: number;
  fgAplicado: number;
  diferencialGenerado: number;
  detalle: Array<{
    folio: string; taxista: string; cuota: number; recaudo: number;
    diferencial: number; fgUsado: number; accion: string;
  }>;
};

/**
 * Monthly close: for each active credit, compare accumulated recaudo vs cuota.
 * Apply FG where needed. Generate Conekta payment links for diferenciales.
 */
export async function cierreMensual(sendWa?: (to: string, body: string) => Promise<void>): Promise<CierreResult> {
  const creditos = await airtableFetch(TABLE_CREDITOS, {
    filterByFormula: `OR({Estatus}="Activo",{Estatus}="Mora Leve")`,
  });

  const result: CierreResult = { creditosProcesados: 0, gnvCubrio: 0, fgAplicado: 0, diferencialGenerado: 0, detalle: [] };

  for (const credito of creditos) {
    const folio = credito.Folio;
    const mesActual = credito["Mes Actual"] || 0;
    const cuota = credito["Cuota Actual"] || 0;
    const saldoFG = credito["Saldo FG"] || 0;
    const telefono = credito.Telefono || "";

    const recaudoRows = await airtableFetch(TABLE_RECAUDO, {
      filterByFormula: `AND({Folio}="${folio}",{Mes}=${mesActual})`,
    });
    const recaudoTotal = recaudoRows.reduce((s: number, r: any) => s + (r.Recaudo || 0), 0);

    let accion = "";
    let fgUsado = 0;
    let diferencial = 0;
    let nuevoSaldoFG = saldoFG;
    let nuevoEstatus = credito.Estatus;
    let diasAtraso = credito["Dias Atraso"] || 0;

    if (recaudoTotal >= cuota) {
      accion = "GNV cubre cuota completa";
      if (nuevoSaldoFG < 20000) {
        nuevoSaldoFG = Math.min(20000, nuevoSaldoFG + 334);
      }
      diasAtraso = 0;
      nuevoEstatus = "Activo";
      result.gnvCubrio++;

      if (sendWa && telefono) {
        // Mensaje cálido de cuota cubierta + aplicación al FG. Dedup 45d por folio.
        try {
          const { notificarCuotaCubierta } = await import("./conductor-proactivo-engine");
          const excedente = Math.max(0, recaudoTotal - cuota);
          await notificarCuotaCubierta(
            telefono,
            credito.Taxista || "",
            folio,
            mesActual,
            recaudoTotal,
            cuota,
            excedente,
            sendWa as any,
          );
        } catch {
          // Fallback al mensaje original si el engine falla
          await sendWa(telefono, `*Cierre mes ${mesActual}*\nTu recaudo GNV ($${recaudoTotal.toLocaleString()}) cubrio tu cuota completa ($${cuota.toLocaleString()}).\nSolo pagas: $334 (Fondo de Garantia).\nFG acumulado: $${nuevoSaldoFG.toLocaleString()}/20,000.`);
        }
      }
    } else if (saldoFG > 0) {
      diferencial = cuota - recaudoTotal;
      fgUsado = Math.min(diferencial, saldoFG);
      nuevoSaldoFG = saldoFG - fgUsado;
      const resto = diferencial - fgUsado;
      accion = resto > 0 ? `FG parcial ($${fgUsado}), diferencial $${resto}` : `FG cubrio diferencial ($${fgUsado})`;
      
      if (resto > 0) {
        result.diferencialGenerado++;
        diasAtraso = 0;
        if (sendWa && telefono) {
          await sendWa(telefono, `*Cierre mes ${mesActual}*\nRecaudo GNV: $${recaudoTotal.toLocaleString()}\nCuota: $${cuota.toLocaleString()}\nFG aplicado: $${fgUsado.toLocaleString()}\n*Diferencial pendiente: $${resto.toLocaleString()}*\nTienes 5 dias habiles para pagar.\nCLABE: 152680120000787681 (Bancrea)\nReferencia: ${folio}`);
        }
      } else {
        diasAtraso = 0;
        if (sendWa && telefono) {
          await sendWa(telefono, `*Cierre mes ${mesActual}*\nRecaudo GNV: $${recaudoTotal.toLocaleString()}\nDiferencial cubierto por tu Fondo de Garantia.\nFG restante: $${nuevoSaldoFG.toLocaleString()}/20,000.`);
        }
      }
      result.fgAplicado++;
    } else {
      diferencial = cuota - recaudoTotal;
      accion = `Diferencial total $${diferencial} — FG agotado`;
      result.diferencialGenerado++;
      if (sendWa && telefono) {
        await sendWa(telefono, `*Cierre mes ${mesActual}*\nRecaudo GNV: $${recaudoTotal.toLocaleString()}\nCuota: $${cuota.toLocaleString()}\n*Diferencial: $${diferencial.toLocaleString()}*\nFondo de Garantia agotado.\n*Paga en 5 dias habiles para evitar mora ($250 + 2%)*\nCLABE: 152680120000787681 (Bancrea)\nReferencia: ${folio}`);
      }
    }

    const nuevoMes = mesActual + 1;
    const saldoCapital = credito["Saldo Capital"] || 0;
    
    await airtableUpdate(TABLE_CREDITOS, credito._id, {
      "Mes Actual": nuevoMes,
      "Meses Pagados": (credito["Meses Pagados"] || 0) + (diferencial === 0 ? 1 : 0),
      "Saldo FG": nuevoSaldoFG,
      "Dias Atraso": diasAtraso,
      "Estatus": nuevoEstatus,
    });

    for (const rr of recaudoRows) {
      await airtableUpdate(TABLE_RECAUDO, rr._id, {
        "Cuota": cuota,
        "Diferencial": Math.max(0, cuota - recaudoTotal),
      });
    }

    result.creditosProcesados++;
    result.detalle.push({
      folio, taxista: credito.Taxista || "?", cuota, recaudo: recaudoTotal,
      diferencial, fgUsado, accion,
    });
  }

  return result;
}

// ===== FORMATTERS =====

/**
 * Format multi-product summary for WhatsApp (director report)
 */
export function formatRecaudoSummary(summary: RecaudoSummary): string {
  const lines = [
    `*RECAUDO GNV PROCESADO*`,
    `Periodo: ${summary.periodo}`,
    `Cargas: ${summary.totalRows} | LEQ: ${summary.totalLitros.toLocaleString()} | Total: $${summary.totalRecaudo.toLocaleString()}`,
    `Contratos actualizados: ${summary.creditosActualizados}`,
  ];

  // Joylong section
  if (summary.joylong.contratos > 0) {
    lines.push(``, `*JOYLONG AHORRO* (${summary.joylong.contratos} contratos: $${summary.joylong.recaudo.toLocaleString()})`);
    for (const d of summary.joylong.detalle) {
      lines.push(`- ${d.cliente} (${d.folio}): $${d.recaudo.toLocaleString()} / ${d.litros} LEQ [${d.placa}]`);
    }
  }

  // Kit section
  if (summary.kitConversion.contratos > 0) {
    lines.push(``, `*KIT CONVERSION* (${summary.kitConversion.contratos} contratos: $${summary.kitConversion.recaudo.toLocaleString()})`);
    for (const d of summary.kitConversion.detalle) {
      lines.push(`- ${d.cliente} (${d.folio}): $${d.recaudo.toLocaleString()} / ${d.litros} LEQ [${d.placa}]`);
    }
  }

  // Taxi section
  if (summary.taxiRenovacion.contratos > 0) {
    lines.push(``, `*TAXI RENOVACION* (${summary.taxiRenovacion.contratos} creditos: $${summary.taxiRenovacion.recaudo.toLocaleString()})`);
    for (const d of summary.taxiRenovacion.detalle) {
      lines.push(`- ${d.placa} (${d.folio}): $${d.recaudo.toLocaleString()} / ${d.litros} LEQ`);
    }
  }

  if (summary.placasNoEncontradas.length > 0) {
    lines.push(``, `⚠️ *PLACAS NO REGISTRADAS* (recaudo perdido):`);
    for (const p of summary.placasNoEncontradas) {
      lines.push(`  ❌ ${p} — registrar en Placas Recaudo para que se contabilice`);
    }
  }

  return lines.join("\n");
}

/**
 * Format monthly close for WhatsApp (director report)
 */
export function formatCierreReport(cierre: CierreResult): string {
  const lines = [
    `*CIERRE MENSUAL CMU*`,
    `Creditos: ${cierre.creditosProcesados}`,
    `GNV cubrio cuota: ${cierre.gnvCubrio}`,
    `FG aplicado: ${cierre.fgAplicado}`,
    `Diferenciales generados: ${cierre.diferencialGenerado}`,
  ];

  if (cierre.detalle.length > 0) {
    lines.push(``);
    for (const d of cierre.detalle) {
      const icon = d.diferencial === 0 ? "OK" : "!!";
      lines.push(`${icon} ${d.taxista}: cuota $${d.cuota.toLocaleString()} | GNV $${d.recaudo.toLocaleString()} | ${d.accion}`);
    }
  }

  return lines.join("\n");
}
