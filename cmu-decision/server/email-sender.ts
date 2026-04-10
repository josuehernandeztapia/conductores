/**
 * email-sender.ts
 * Envía emails con Resend API (resend.com).
 * Requiere: RESEND_API_KEY en env vars.
 * From: reporte@conductores.lat (o noreply@conductores.lat)
 */

import { Resend } from "resend";

const ANGELES_EMAIL = "mireles.ageles60@gmail.com";
const FROM_EMAIL = "reporte@conductores.lat"; // debe estar verificado en Resend
const FROM_NAME = "CMU — Conductores del Mundo";

export async function sendWeeklyReportEmail(
  pdfBuffer: Buffer,
  recipientEmail: string = ANGELES_EMAIL,
  reportSummary: { total: number; sinAvance: number; completos: number },
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY no configurado en variables de entorno.");
  }

  const resend = new Resend(apiKey);

  const now = new Date();
  const dateStr = now.toLocaleDateString("es-MX", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "America/Mexico_City",
  });

  const filename = `reporte-cmu-${now.toISOString().slice(0, 10)}.pdf`;

  try {
    const result = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [recipientEmail],
      subject: `Reporte semanal CMU — ${dateStr}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #1a1a2e; border-bottom: 2px solid #eee; padding-bottom: 8px;">
            Reporte Semanal de Originación
          </h2>
          <p style="color: #555;">Hola Ángeles,</p>
          <p style="color: #555;">
            Aquí está tu reporte semanal de trámites al ${dateStr}.
          </p>

          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr style="background: #f8f9fa;">
              <td style="padding: 10px 12px; border: 1px solid #dee2e6; font-weight: bold;">Trámites activos</td>
              <td style="padding: 10px 12px; border: 1px solid #dee2e6; text-align: center; font-size: 18px; font-weight: bold; color: #1a1a2e;">${reportSummary.total}</td>
            </tr>
            <tr>
              <td style="padding: 10px 12px; border: 1px solid #dee2e6; font-weight: bold;">Sin avance (3+ días)</td>
              <td style="padding: 10px 12px; border: 1px solid #dee2e6; text-align: center; font-size: 18px; font-weight: bold; color: ${reportSummary.sinAvance > 0 ? '#e74c3c' : '#27ae60'};">${reportSummary.sinAvance}</td>
            </tr>
            <tr style="background: #f8f9fa;">
              <td style="padding: 10px 12px; border: 1px solid #dee2e6; font-weight: bold;">Listos para firma</td>
              <td style="padding: 10px 12px; border: 1px solid #dee2e6; text-align: center; font-size: 18px; font-weight: bold; color: #27ae60;">${reportSummary.completos}</td>
            </tr>
          </table>

          <p style="color: #555;">
            El reporte detallado con documentos faltantes por taxista está adjunto en PDF.
          </p>

          <p style="color: #aaa; font-size: 11px; margin-top: 32px; border-top: 1px solid #eee; padding-top: 12px;">
            Este correo fue generado automáticamente por el sistema CMU.<br>
            Si tienes dudas, contacta a tu coordinador.
          </p>
        </div>
      `,
      attachments: [
        {
          filename,
          content: pdfBuffer,
        },
      ],
    });

    console.log(`[Email] Reporte enviado a ${recipientEmail}: ${result.data?.id}`);
    return { success: true, messageId: result.data?.id };
  } catch (err: any) {
    console.error(`[Email] Error enviando reporte:`, err.message);
    return { success: false, error: err.message };
  }
}
