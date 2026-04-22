/**
 * Conductor Proactivo Engine
 *
 * Tres funciones que mantienen al conductor informado sin que pregunte:
 *
 * 1) avisoRecaudoDia25()
 *    El día 25 de cada mes, resume al conductor su recaudo acumulado
 *    vs la cuota del mes, y le anticipa cuándo llegará la liga de pago.
 *
 * 2) confirmacionRecaudoCubreCuota()
 *    Cuando el cierre mensual detecta que el recaudo cubre la cuota,
 *    envía un mensaje de "este mes tu GNV cubrió todo, diferencial $0".
 *    Se llama desde el cierre mensual (día 1).
 *
 * 3) notificacionPostFirma()
 *    Cuando un contrato TSR + PAG se firma, notifica al taxista, al
 *    director y al promotor con un resumen consolidado.
 *
 * Usa proactive_messages (Neon) para dedup.
 */

import { neon } from "@neondatabase/serverless";
import { getAllCredits } from "./airtable-client";

type SendWaFn = (to: string, body: string) => Promise<any>;

const AIRTABLE_BASE = "appXxbjjGzXFiX7gk";
const TABLE_CREDITOS = "tblA62WNhSb4xYfYv";
const TABLE_AHORRO_JOYLONG = "tblUjkOQ2rWvBRRmw";
const TABLE_KIT_CONVERSION = "tbletXmlYRwisBcaO";
const TABLE_RECAUDO = "tblSUWmIE8Ma5be9u";

const getSql = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  return neon(url);
};

async function airtableFetch(tableId: string, params: Record<string, string> = {}): Promise<any[]> {
  const token = process.env.AIRTABLE_PAT || "";
  if (!token) return [];
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}${qs ? "?" + qs : ""}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Airtable ${tableId}: ${res.status}`);
  const data = await res.json();
  return (data.records || []).map((r: any) => ({ _id: r.id, ...r.fields }));
}

async function wasSentRecently(phone: string, messageType: string, withinHours = 24): Promise<boolean> {
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT id FROM proactive_messages
      WHERE phone = ${phone} AND message_type = ${messageType}
        AND sent_at > NOW() - (${withinHours} || ' hours')::interval
      LIMIT 1
    `;
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function logMessage(phone: string, messageType: string, folio: string | null, text: string) {
  try {
    const sql = getSql();
    await sql`
      INSERT INTO proactive_messages (phone, message_type, folio, message_text)
      VALUES (${phone}, ${messageType}, ${folio}, ${text})
    `;
  } catch {
    /* non-blocking */
  }
}

// ===== 1) Aviso día 25 =====

export interface AvisoDia25Result {
  enviados: number;
  errores: string[];
  detalle: Array<{
    folio: string;
    cliente: string;
    telefono: string;
    recaudo: number;
    cuota: number;
    diferencial: number;
    status: "cubierta" | "parcial" | "sin_recaudo";
  }>;
}

/**
 * Para cada crédito TSR activo, calcula el recaudo del mes en curso y
 * estima cuánto falta de diferencial. Envía WhatsApp informativo.
 *
 * Para Joylong Ahorro y Kit Conversión NO aplica diferencial — pero se
 * envía un resumen del ahorro acumulado en el mes igual.
 */
export async function avisoRecaudoDia25(sendWa: SendWaFn, opts: { dryRun?: boolean } = {}): Promise<AvisoDia25Result> {
  const result: AvisoDia25Result = { enviados: 0, errores: [], detalle: [] };
  const now = new Date();
  const mesEnCurso = now.toISOString().slice(0, 7); // YYYY-MM
  const dryRun = !!opts.dryRun;

  // ===== Taxi Renovación (TSR) — con cuota + diferencial =====
  try {
    const creditos = await getAllCredits();
    for (const c of creditos as any[]) {
      const estatus = (c.Estatus || "").toLowerCase();
      if (!estatus.includes("activo") && !estatus.includes("mora")) continue;

      const folio = c.Folio || "";
      const cliente = c.Taxista || "";
      const telefono = (c.Telefono || "").replace(/[^0-9]/g, "");
      if (!folio || !telefono) continue;

      const mesActual = c["Mes Actual"] || 0;
      const cuota = c["Cuota Actual"] || 0;

      // Buscar el recaudo del mes en curso
      let recaudo = 0;
      try {
        const recaudoRows = await airtableFetch(TABLE_RECAUDO, {
          filterByFormula: `AND({Folio}="${folio}",{Mes}=${mesActual})`,
          maxRecords: "1",
        });
        if (recaudoRows.length > 0) {
          recaudo = Math.round(recaudoRows[0].Recaudo || 0);
        }
      } catch {
        /* seguir con 0 */
      }

      const diferencial = Math.max(0, cuota - recaudo);
      const status: "cubierta" | "parcial" | "sin_recaudo" =
        recaudo >= cuota ? "cubierta" :
        recaudo > 0 ? "parcial" : "sin_recaudo";

      result.detalle.push({ folio, cliente, telefono, recaudo, cuota, diferencial, status });

      const key = `aviso_dia25_${folio}_${mesEnCurso}`;
      const alreadySent = await wasSentRecently(telefono, key, 24 * 30); // Max 1 vez al mes
      if (alreadySent) continue;

      let msg = "";
      if (status === "cubierta") {
        msg = `💚 Hola ${cliente}, tu recaudo GNV del mes va en *$${recaudo.toLocaleString()}* y tu cuota es *$${cuota.toLocaleString()}*.\n\n✅ *Ya cubriste tu cuota de este mes.* El excedente se aplica a tu Fondo de Garantía.\n\nEl día 1 del próximo mes te llega el estado de cuenta final.`;
      } else if (status === "parcial") {
        msg = `📊 Hola ${cliente}, estado de tu cuenta CMU:\n\nRecaudo GNV este mes: *$${recaudo.toLocaleString()}*\nCuota del mes: *$${cuota.toLocaleString()}*\nFalta cubrir: *$${diferencial.toLocaleString()}*\n\n⏰ El *día 1 del próximo mes* te llegará la liga de pago de Conekta por el diferencial (si el recaudo no alcanza a cubrir la cuota antes).\n\nSigue cargando en estaciones con convenio para aumentar tu recaudo.`;
      } else {
        msg = `⚠️ Hola ${cliente}, este mes no hemos registrado cargas de gas en tu unidad.\n\nTu cuota del mes es *$${cuota.toLocaleString()}*. Si no hay recaudo, el día 1 te llegará una liga de pago por el total.\n\n¿Está todo bien con la unidad?`;
      }

      try {
        if (!dryRun) {
          await sendWa(`whatsapp:+${telefono}`, msg);
          await logMessage(telefono, key, folio, msg);
        }
        result.enviados++;
      } catch (e: any) {
        result.errores.push(`TSR ${folio}: ${e.message}`);
      }
    }
  } catch (e: any) {
    result.errores.push(`TSR query: ${e.message}`);
  }

  // ===== Joylong Ahorro — no hay cuota, solo informar acumulado =====
  try {
    const joylongs = await airtableFetch(TABLE_AHORRO_JOYLONG, {
      filterByFormula: `OR({Estatus}="Ahorrando",{Estatus}="Gatillo Alcanzado")`,
    });
    for (const j of joylongs) {
      const folio = j.Folio || "";
      const cliente = j.Cliente || "";
      const telefono = (j.Telefono || "").replace(/[^0-9]/g, "");
      if (!folio || !telefono) continue;

      const acumulado = Math.round(j["Ahorro Acumulado"] || 0);
      const gatillo = j.Gatillo || 399500;
      const precio = j["Precio Vehiculo"] || 799000;
      const pctAvance = (acumulado / precio) * 100;
      const faltaGatillo = Math.max(0, gatillo - acumulado);

      const key = `aviso_dia25_${folio}_${mesEnCurso}`;
      const alreadySent = await wasSentRecently(telefono, key, 24 * 30);
      if (alreadySent) continue;

      let msg: string;
      if (acumulado >= gatillo) {
        msg = `🎉 Hola ${cliente}, buenas noticias:\n\nTu ahorro acumulado: *$${acumulado.toLocaleString()}*\nGatillo alcanzado: ✅ *$${gatillo.toLocaleString()}*\n\n*Ya tienes el 50% del vehículo ahorrado.* Contacta a tu promotor para conocer los siguientes pasos.`;
      } else {
        msg = `💰 Hola ${cliente}, tu ahorro CMU:\n\nAcumulado: *$${acumulado.toLocaleString()}* (${pctAvance.toFixed(1)}% del precio)\nFaltan para el gatillo: *$${faltaGatillo.toLocaleString()}*\n\nTu ahorro crece con cada carga de gas. Sigue así.`;
      }

      try {
        if (!dryRun) {
          await sendWa(`whatsapp:+${telefono}`, msg);
          await logMessage(telefono, key, folio, msg);
        }
        result.enviados++;
      } catch (e: any) {
        result.errores.push(`Joylong ${folio}: ${e.message}`);
      }
    }
  } catch (e: any) {
    result.errores.push(`Joylong query: ${e.message}`);
  }

  // ===== Kit Conversión — cuota mensual fija, resumen de aportes GNV =====
  try {
    const kits = await airtableFetch(TABLE_KIT_CONVERSION, {
      filterByFormula: `{Estatus}="Activo"`,
    });
    for (const k of kits) {
      const folio = k.Folio || "";
      const cliente = k.Cliente || "";
      const telefono = (k.Telefono || "").replace(/[^0-9]/g, "");
      if (!folio || !telefono) continue;

      const cuotaMensual = Math.round(k["Cuota Mensual"] || 0);
      const saldoPendiente = Math.round(k["Saldo Pendiente"] || 0);
      const mesActual = k["Mes Actual"] || 1;
      const mesesPagados = k["Meses Pagados"] || 0;
      const parcialidades = k["Parcialidades"] || 12;

      // Recaudo del mes en curso desde placas recaudo (si existe)
      let recaudoMes = 0;
      try {
        const recaudoRows = await airtableFetch(TABLE_RECAUDO, {
          filterByFormula: `AND({Folio}="${folio}",{Mes}=${mesActual})`,
          maxRecords: "1",
        });
        if (recaudoRows.length > 0) recaudoMes = Math.round(recaudoRows[0].Recaudo || 0);
      } catch {
        /* seguir con 0 */
      }

      const diferencial = Math.max(0, cuotaMensual - recaudoMes);
      const status: "cubierta" | "parcial" | "sin_recaudo" =
        recaudoMes >= cuotaMensual ? "cubierta" :
        recaudoMes > 0 ? "parcial" : "sin_recaudo";

      result.detalle.push({
        folio, cliente, telefono,
        recaudo: recaudoMes, cuota: cuotaMensual, diferencial, status,
      });

      const key = `aviso_dia25_${folio}_${mesEnCurso}`;
      const alreadySent = await wasSentRecently(telefono, key, 24 * 30);
      if (alreadySent) continue;

      let msg: string;
      if (status === "cubierta") {
        msg = `💚 Hola ${cliente}, tu recaudo GNV del mes: *$${recaudoMes.toLocaleString()}* — cuota Kit Conversión: *$${cuotaMensual.toLocaleString()}*.\n\n✅ *Ya cubriste la cuota del mes ${mesActual}/${parcialidades}.*\nSaldo pendiente del kit: *$${saldoPendiente.toLocaleString()}*.\n\nEl día 1 del próximo mes te llega el estado de cuenta.`;
      } else if (status === "parcial") {
        msg = `📊 Hola ${cliente}, estado de tu Kit Conversión:\n\nRecaudo GNV este mes: *$${recaudoMes.toLocaleString()}*\nCuota mensual ${mesActual}/${parcialidades}: *$${cuotaMensual.toLocaleString()}*\nFalta cubrir: *$${diferencial.toLocaleString()}*\nSaldo pendiente del kit: *$${saldoPendiente.toLocaleString()}*\n\n⏰ El *día 1 del próximo mes* te llegará la liga de pago por el diferencial (si el recaudo no alcanza antes).`;
      } else {
        msg = `⚠️ Hola ${cliente}, este mes no hemos registrado cargas de gas.\n\nCuota Kit Conversión ${mesActual}/${parcialidades}: *$${cuotaMensual.toLocaleString()}*\nSaldo pendiente: *$${saldoPendiente.toLocaleString()}*\n\nSi no hay recaudo, el día 1 te llega liga de pago por el total. ¿Está todo bien con la unidad?`;
      }

      try {
        if (!dryRun) {
          await sendWa(`whatsapp:+${telefono}`, msg);
          await logMessage(telefono, key, folio, msg);
        }
        result.enviados++;
      } catch (e: any) {
        result.errores.push(`Kit ${folio}: ${e.message}`);
      }
    }
  } catch (e: any) {
    result.errores.push(`Kit query: ${e.message}`);
  }

  return result;
}

// ===== 2) Confirmación cuando recaudo cubre cuota (día 1) =====
// Esta función se llama desde cierre-mensual.ts al procesar cada crédito.
// La dejo exportada para que cierre-mensual la invoque.

export async function notificarCuotaCubierta(
  telefono: string,
  cliente: string,
  folio: string,
  mes: number,
  recaudo: number,
  cuota: number,
  excedenteFG: number,
  sendWa: SendWaFn,
): Promise<boolean> {
  const cleanPhone = telefono.replace(/[^0-9]/g, "");
  if (!cleanPhone) return false;

  const key = `cuota_cubierta_${folio}_${mes}`;
  const alreadySent = await wasSentRecently(cleanPhone, key, 24 * 45);
  if (alreadySent) return false;

  const msg = `🎉 Hola ${cliente}, *excelentes noticias*:\n\nTu recaudo GNV del mes: *$${recaudo.toLocaleString()}*\nCuota del mes ${mes}: *$${cuota.toLocaleString()}*\n\n✅ *Tu carga de gas cubrió toda la cuota — diferencial $0.*${excedenteFG > 0 ? `\n\nExcedente aplicado al Fondo de Garantía: *$${excedenteFG.toLocaleString()}*` : ""}\n\nSigue así 🚕`;

  try {
    await sendWa(`whatsapp:+${cleanPhone}`, msg);
    await logMessage(cleanPhone, key, folio, msg);
    return true;
  } catch (e: any) {
    console.error(`[ProactivoConductor] cuota_cubierta ${folio}: ${e.message}`);
    return false;
  }
}

// ===== 3) Notificación post-firma =====

export interface PostFirmaContext {
  folio: string;
  nombreTaxista: string;
  telefonoTaxista: string;
  marca?: string;
  modelo?: string;
  anio?: number | string;
  cuotaMensual: number;
  precioTotal: number;
  fechaFirma: string; // ISO
}

export async function notificarPostFirma(
  ctx: PostFirmaContext,
  sendWa: SendWaFn,
  directorPhone: string,
  promotorPhone: string,
): Promise<{ taxista: boolean; director: boolean; promotor: boolean }> {
  const resultado = { taxista: false, director: false, promotor: false };
  const fecha = new Date(ctx.fechaFirma).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
  const vehiculo = [ctx.marca, ctx.modelo, ctx.anio].filter(Boolean).join(" ") || "tu unidad";

  // === TAXISTA ===
  if (ctx.telefonoTaxista) {
    const cleanPhone = ctx.telefonoTaxista.replace(/[^0-9]/g, "");
    const key = `post_firma_taxista_${ctx.folio}`;
    const alreadySent = await wasSentRecently(cleanPhone, key, 24 * 7);
    if (!alreadySent) {
      const msg = `🎉 Hola ${ctx.nombreTaxista}, bienvenido a CMU:\n\n*Tu contrato ${ctx.folio} está firmado.*\n\n🚕 Vehículo: ${vehiculo}\n💵 Precio total: $${ctx.precioTotal.toLocaleString()}\n📅 Cuota mensual: *$${ctx.cuotaMensual.toLocaleString()}*\n✍️ Firmado: ${fecha}\n\nRecuerda:\n• Anticipo a capital de *$50,000* al día 56 (semana 8).\n• Tu pago mensual se cubre con cada carga de gas (sobreprecio por LEQ).\n• Tu Fondo de Garantía te protege si un mes cargas poco.\n\nCualquier duda, escribe por aquí. Tu promotora te contactará para coordinar la entrega del vehículo.`;
      try {
        await sendWa(`whatsapp:+${cleanPhone}`, msg);
        await logMessage(cleanPhone, key, ctx.folio, msg);
        resultado.taxista = true;
      } catch (e: any) {
        console.error(`[PostFirma] taxista ${ctx.folio}: ${e.message}`);
      }
    }
  }

  // === DIRECTOR ===
  const keyDir = `post_firma_director_${ctx.folio}`;
  const alreadyDir = await wasSentRecently(directorPhone, keyDir, 24 * 7);
  if (!alreadyDir) {
    const msgDir = `✅ *Contrato firmado — ${ctx.folio}*\n\nTaxista: ${ctx.nombreTaxista}\nVehículo: ${vehiculo}\nPrecio total: $${ctx.precioTotal.toLocaleString()}\nCuota: $${ctx.cuotaMensual.toLocaleString()}/mes\nFirma: ${fecha}\n\nEsperando: anticipo \$50k día 56 + entrega vehículo.`;
    try {
      await sendWa(`whatsapp:+${directorPhone}`, msgDir);
      await logMessage(directorPhone, keyDir, ctx.folio, msgDir);
      resultado.director = true;
    } catch (e: any) {
      console.error(`[PostFirma] director ${ctx.folio}: ${e.message}`);
    }
  }

  // === PROMOTOR ===
  const keyProm = `post_firma_promotor_${ctx.folio}`;
  const alreadyProm = await wasSentRecently(promotorPhone, keyProm, 24 * 7);
  if (!alreadyProm) {
    const msgProm = `📋 Contrato firmado: *${ctx.folio}*\n${ctx.nombreTaxista}\n${vehiculo}\nCuota $${ctx.cuotaMensual.toLocaleString()}/mes\nFirma: ${fecha}\n\nCoordinar entrega del vehículo con el taxista.`;
    try {
      await sendWa(`whatsapp:+${promotorPhone}`, msgProm);
      await logMessage(promotorPhone, keyProm, ctx.folio, msgProm);
      resultado.promotor = true;
    } catch (e: any) {
      console.error(`[PostFirma] promotor ${ctx.folio}: ${e.message}`);
    }
  }

  return resultado;
}
