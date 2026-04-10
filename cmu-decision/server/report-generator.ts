/**
 * report-generator.ts
 * Genera el reporte semanal de folios en PDF usando pdfkit.
 * Retorna un Buffer con el PDF listo para adjuntar al email.
 */

import PDFDocument from "pdfkit";
import { neon } from "@neondatabase/serverless";

function getSQL() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("No DATABASE_URL");
  return neon(url);
}

export interface FolioReportRow {
  folio: string;
  taxistaName: string;
  estado: string;
  diasSinAvance: number;
  docsCapturados: number;
  totalDocs: number;
  docsFaltantes: string[];
  entrevistaCompleta: boolean;
}

// Doc labels for human-readable names
const DOC_LABELS: Record<string, string> = {
  ine_frente: "INE Frente",
  ine_reverso: "INE Reverso",
  licencia: "Licencia de Conducir",
  factura_vehiculo: "Factura del Vehículo",
  csf: "Constancia Situación Fiscal",
  comprobante_domicilio: "Comprobante de Domicilio",
  tarjeta_circulacion: "Tarjeta de Circulación",
  concesion: "Concesión de Taxi",
  estado_cuenta: "Estado de Cuenta",
  historial_gnv: "Historial GNV / Tickets",
  membresia_gremial: "Carta Membresía Gremial",
  selfie_ine: "Selfie con INE",
  ine_operador: "INE del Operador",
  fotos_unidad: "Fotos de la Unidad",
};

const TOTAL_DOCS = Object.keys(DOC_LABELS).length; // 14

export async function buildReportData(): Promise<FolioReportRow[]> {
  const sql = getSQL();

  // Get all active originations
  const originations = await sql`
    SELECT o.id, o.folio, o.estado, o.updated_at, o.created_at,
           t.nombre as taxista_nombre
    FROM originations o
    LEFT JOIN taxistas t ON t.id = o.taxista_id
    WHERE o.estado NOT IN ('RECHAZADO', 'COMPLETADO', 'CANCELADO')
    ORDER BY o.updated_at ASC
  ` as any[];

  const rows: FolioReportRow[] = [];

  for (const orig of originations) {
    // Get captured documents
    const docs = await sql`
      SELECT tipo FROM documents
      WHERE origination_id = ${orig.id}
      AND (image_data IS NOT NULL OR ocr_result IS NOT NULL)
    ` as any[];

    const capturedKeys = new Set(docs.map((d: any) => d.tipo));
    const docsFaltantes = Object.keys(DOC_LABELS).filter(k => !capturedKeys.has(k));

    // Check interview
    const evalRow = await sql`
      SELECT id FROM evaluaciones_taxi WHERE folio_id = ${orig.folio} LIMIT 1
    ` as any[];

    const updatedAt = new Date(orig.updated_at || orig.created_at);
    const diasSinAvance = Math.floor((Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24));

    rows.push({
      folio: orig.folio,
      taxistaName: orig.taxista_nombre || "Sin nombre",
      estado: orig.estado,
      diasSinAvance,
      docsCapturados: capturedKeys.size,
      totalDocs: TOTAL_DOCS,
      docsFaltantes: docsFaltantes.map(k => DOC_LABELS[k] || k),
      entrevistaCompleta: evalRow.length > 0,
    });
  }

  return rows;
}

export async function generateWeeklyReportPDF(): Promise<Buffer> {
  const rows = await buildReportData();
  const now = new Date();
  const dateStr = now.toLocaleDateString("es-MX", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "America/Mexico_City",
  });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "LETTER" });
    const buffers: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    // ─── Header ───────────────────────────────────────────────────────────────
    doc.fontSize(18).fillColor("#1a1a2e").font("Helvetica-Bold")
      .text("Conductores del Mundo (CMU)", { align: "center" });
    doc.fontSize(12).fillColor("#444").font("Helvetica")
      .text("Reporte Semanal de Originación", { align: "center" });
    doc.fontSize(10).fillColor("#666")
      .text(dateStr, { align: "center" });

    doc.moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(572, doc.y).strokeColor("#cccccc").stroke();
    doc.moveDown(0.5);

    // ─── Summary KPIs ─────────────────────────────────────────────────────────
    const total = rows.length;
    const sinAvance = rows.filter(r => r.diasSinAvance >= 3).length;
    const completos = rows.filter(r => r.docsFaltantes.length === 0 && r.entrevistaCompleta).length;
    const enProceso = total - completos;

    doc.fontSize(11).fillColor("#1a1a2e").font("Helvetica-Bold")
      .text("Resumen");
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#333").font("Helvetica")
      .text(`• Trámites activos: ${total}`)
      .text(`• En proceso: ${enProceso}`)
      .text(`• Completos (listos para firma): ${completos}`)
      .text(`• Sin avance (3+ días): ${sinAvance}`);

    doc.moveDown(0.8);

    // ─── Per-folio detail ─────────────────────────────────────────────────────
    doc.fontSize(11).fillColor("#1a1a2e").font("Helvetica-Bold")
      .text("Detalle por Taxista");
    doc.moveDown(0.4);

    for (const row of rows) {
      // Color indicator
      let statusColor = "#27ae60"; // green = ok
      if (row.diasSinAvance >= 7) statusColor = "#e74c3c"; // red = stale
      else if (row.diasSinAvance >= 3) statusColor = "#f39c12"; // amber = warning

      const startY = doc.y;

      // Name + folio
      doc.fontSize(10).fillColor("#1a1a2e").font("Helvetica-Bold")
        .text(`${row.taxistaName}`, 40, startY, { continued: true });
      doc.fillColor("#666").font("Helvetica")
        .text(`  ${row.folio}`, { continued: true });

      // Days badge
      const daysText = row.diasSinAvance === 0 ? "hoy" : `${row.diasSinAvance}d sin avance`;
      doc.fillColor(statusColor).text(`  [${daysText}]`);

      // Docs progress
      doc.fontSize(9).fillColor("#555").font("Helvetica")
        .text(`  Documentos: ${row.docsCapturados}/${row.totalDocs}  |  Entrevista: ${row.entrevistaCompleta ? "✓ completa" : "pendiente"}`);

      if (row.docsFaltantes.length > 0) {
        doc.fontSize(8).fillColor("#c0392b")
          .text(`  Faltan: ${row.docsFaltantes.join(", ")}`, {
            indent: 10,
            width: 490,
          });
      } else if (!row.entrevistaCompleta) {
        doc.fontSize(8).fillColor("#e67e22")
          .text(`  Todos los documentos completos. Pendiente: entrevista.`, { indent: 10 });
      } else {
        doc.fontSize(8).fillColor("#27ae60")
          .text(`  Expediente completo — listo para firma.`, { indent: 10 });
      }

      doc.moveDown(0.6);

      // Separator
      doc.moveTo(40, doc.y).lineTo(572, doc.y).strokeColor("#eeeeee").stroke();
      doc.moveDown(0.3);

      // Page break if needed
      if (doc.y > 680) {
        doc.addPage();
      }
    }

    // ─── Footer ───────────────────────────────────────────────────────────────
    doc.moveDown(1);
    doc.fontSize(8).fillColor("#aaa").font("Helvetica")
      .text(`Generado automáticamente por el sistema CMU — ${now.toISOString()}`, { align: "center" });

    doc.end();
  });
}
