/**
 * Abandono Engine — Detección temprana de abandono de unidad por placa
 *
 * Si una placa activa deja de cargar GNV por varios días, es señal
 * temprana de que el operador dejó de trabajar (unidad en taller,
 * operador enfermo, abandono real). Detectarlo el día 3-5 en vez de
 * esperar al cierre mensual (día 1 del mes siguiente) permite actuar
 * antes de que acumule mora grave.
 *
 * Escalera de umbrales:
 *   - 3 días sin recaudo → log interno, sin notificación
 *   - 5 días sin recaudo → WhatsApp al operador preguntando si todo bien
 *   - 7 días sin recaudo → escalar a director + promotor
 *
 * Fuente de datos:
 *   Airtable TABLE_PAGOS, filtrando por Concepto='Recaudo GNV' y ordenando
 *   por Fecha Pago DESC para encontrar la última carga de cada folio activo.
 *
 * Usa `proactive_messages` (Neon) para dedup y cooldown.
 */

import { neon } from "@neondatabase/serverless";
import { getAllCredits } from "./airtable-client";

type SendWaFn = (to: string, body: string) => Promise<any>;

const AIRTABLE_BASE = "appXxbjjGzXFiX7gk";
const TABLE_PLACAS = "tblb4cdo0wv3qeWxs";
const TABLE_AHORRO_JOYLONG = "tblUjkOQ2rWvBRRmw";
const TABLE_PAGOS = "tbl5RiGyVgeE4EVfE";

const getSql = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  return neon(url);
};

// ===== Airtable helpers (duplicated to keep this module self-contained) =====
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

// ===== Proactive dedup (shared with proactive-agent) =====

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

// ===== Core detection =====

export interface AbandonoEntry {
  folio: string;
  cliente: string;
  telefono: string | null;
  placa: string;
  producto: string;
  diasSinRecaudo: number;
  ultimaCarga: string | null;
  severidad: "warning" | "alert" | "critical";
  accion: string;
}

const UMBRAL_WARNING = 3; // días — solo log
const UMBRAL_ALERT = 5;   // días — WhatsApp al conductor
const UMBRAL_CRITICAL = 7; // días — escalar a director + promotor

/**
 * Escanea todas las placas activas y reporta las que llevan 3+ días sin carga.
 * Devuelve la lista para que el cron decida qué notificaciones enviar.
 */
export async function detectarAbandonoPorPlaca(): Promise<AbandonoEntry[]> {
  const entries: AbandonoEntry[] = [];
  const now = Date.now();

  // 1. Traer todas las placas activas (cualquier producto)
  const placas = await airtableFetch(TABLE_PLACAS, {
    filterByFormula: `{Activa}=TRUE()`,
  });
  if (placas.length === 0) return entries;

  // 2. Traer todos los pagos de concepto "Recaudo GNV" con Fecha Pago reciente
  //    (últimos 30 días — margen generoso para que incluso 7 días de abandono caiga en rango)
  const pagos = await airtableFetch(TABLE_PAGOS, {
    filterByFormula: `AND({Concepto}="Recaudo GNV",{Estatus}="Confirmado",IS_AFTER({Fecha Pago},DATEADD(TODAY(),-30,"days")))`,
  });

  // 3. Por cada placa, encontrar su pago más reciente cruzando por Folio
  //    Como los pagos agrupan por folio (no por placa individual), la fecha
  //    del último pago del folio es la señal: si el folio tuvo pago en S16,
  //    entonces la placa X del folio registró al menos una carga esa semana.
  //    Nota: con varias placas por folio, este enfoque pierde granularidad
  //    (puede que la placa individual sí abandonó pero otra del mismo folio
  //    carga). Es el best-effort sin modificar el esquema de Pagos.
  const ultimosPagosPorFolio = new Map<string, Date>();
  for (const p of pagos) {
    const folio = p.Folio;
    if (!folio || !p["Fecha Pago"]) continue;
    const fecha = new Date(p["Fecha Pago"]);
    const existing = ultimosPagosPorFolio.get(folio);
    if (!existing || fecha > existing) {
      ultimosPagosPorFolio.set(folio, fecha);
    }
  }

  // 4. Para cada placa activa, calcular días sin carga
  for (const placa of placas) {
    const folio = placa.Folio;
    if (!folio) continue;

    const ultimo = ultimosPagosPorFolio.get(folio);
    if (!ultimo) {
      // No hay pago registrado en los últimos 30 días — se considera
      // abandono si la placa tiene >30 días activa y no ha cargado.
      // Por ahora lo saltamos (asumimos es cliente nuevo sin cargas aún).
      continue;
    }

    const diasSinRecaudo = Math.floor((now - ultimo.getTime()) / (1000 * 60 * 60 * 24));
    if (diasSinRecaudo < UMBRAL_WARNING) continue;

    // Buscar teléfono del cliente en Joylong Ahorro (tabla de contratos)
    let telefono: string | null = null;
    try {
      const ahorroRecords = await airtableFetch(TABLE_AHORRO_JOYLONG, {
        filterByFormula: `{Folio}="${folio}"`,
        maxRecords: "1",
      });
      if (ahorroRecords.length > 0) {
        telefono = ahorroRecords[0].Telefono || null;
      }
    } catch {
      /* seguir sin teléfono */
    }

    // Para Taxi Renovación (TSR) el teléfono está en Creditos, lo buscamos ahí
    if (!telefono) {
      try {
        const creditos = await getAllCredits();
        const credito = (creditos as any[]).find((c: any) => c.Folio === folio);
        if (credito) telefono = credito.Telefono || credito.telefono || null;
      } catch {
        /* nada */
      }
    }

    const severidad: AbandonoEntry["severidad"] =
      diasSinRecaudo >= UMBRAL_CRITICAL ? "critical" :
      diasSinRecaudo >= UMBRAL_ALERT ? "alert" : "warning";

    const accion =
      severidad === "critical" ? "escalar a director + promotor" :
      severidad === "alert" ? "WhatsApp al conductor" :
      "log interno";

    entries.push({
      folio,
      cliente: placa.Cliente || "N/A",
      telefono,
      placa: placa.Placa,
      producto: placa.Producto || "desconocido",
      diasSinRecaudo,
      ultimaCarga: ultimo.toISOString().slice(0, 10),
      severidad,
      accion,
    });
  }

  // Deduplicar por folio: si un folio tiene varias placas, la más crítica gana
  const porFolio = new Map<string, AbandonoEntry>();
  for (const e of entries) {
    const existing = porFolio.get(e.folio);
    if (!existing || e.diasSinRecaudo > existing.diasSinRecaudo) {
      porFolio.set(e.folio, e);
    }
  }
  return Array.from(porFolio.values());
}

/**
 * Envía notificaciones según la severidad de cada entrada.
 * Usa cooldown de 48h para conductor y 24h para director/promotor.
 */
export async function notificarAbandono(
  entries: AbandonoEntry[],
  sendWa: SendWaFn,
  directorPhone: string,
  promotorPhone: string,
): Promise<{ notificados: number; escalados: number; errores: string[] }> {
  let notificados = 0;
  let escalados = 0;
  const errores: string[] = [];

  for (const e of entries) {
    try {
      if (e.severidad === "warning") {
        // Solo log interno — nadie se entera
        await logMessage(
          directorPhone,
          `abandono_log_${e.folio}`,
          e.folio,
          `[WARNING] ${e.placa} ${e.cliente} sin cargas ${e.diasSinRecaudo}d`,
        );
        continue;
      }

      if (e.severidad === "alert" && e.telefono) {
        const cleanPhone = e.telefono.replace(/[^0-9]/g, "");
        const key = `abandono_conductor_${e.folio}`;
        const alreadySent = await wasSentRecently(cleanPhone, key, 48);
        if (!alreadySent) {
          const msg = `👋 Hola ${e.cliente}, soy el asistente de CMU.\n\nNotamos que la unidad *${e.placa}* no ha cargado gas en *${e.diasSinRecaudo} días*.\n\n¿Está todo bien con la unidad? ¿Necesitas apoyo?\n\nSi la unidad está en taller o hay algún tema, contéstame por aquí y le aviso a tu promotor.`;
          try {
            await sendWa(`whatsapp:+${cleanPhone}`, msg);
            await logMessage(cleanPhone, key, e.folio, msg);
            notificados++;
          } catch (err: any) {
            errores.push(`alert ${e.folio}: ${err.message}`);
          }
        }
        continue;
      }

      if (e.severidad === "critical") {
        // Escalar: director + promotor. Conductor también si no se le avisó antes.
        if (e.telefono) {
          const cleanPhone = e.telefono.replace(/[^0-9]/g, "");
          const keyCond = `abandono_conductor_${e.folio}`;
          const alreadyCond = await wasSentRecently(cleanPhone, keyCond, 48);
          if (!alreadyCond) {
            const msgCond = `⚠️ Hola ${e.cliente}, la unidad *${e.placa}* lleva *${e.diasSinRecaudo} días sin cargar gas*.\n\nNos preocupa, por favor contáctanos para saber qué está pasando.`;
            try {
              await sendWa(`whatsapp:+${cleanPhone}`, msgCond);
              await logMessage(cleanPhone, keyCond, e.folio, msgCond);
              notificados++;
            } catch (err: any) {
              errores.push(`critical-cond ${e.folio}: ${err.message}`);
            }
          }
        }

        const keyDir = `abandono_director_${e.folio}`;
        const alreadyDir = await wasSentRecently(directorPhone, keyDir, 24);
        if (!alreadyDir) {
          const msgDir = `🔴 *ABANDONO CRÍTICO — ${e.diasSinRecaudo} días*\n\nFolio: *${e.folio}*\nCliente: ${e.cliente}\nPlaca: ${e.placa}\nProducto: ${e.producto}\nÚltima carga: ${e.ultimaCarga}\nTel cliente: ${e.telefono || "SIN TELÉFONO"}\n\nRequiere seguimiento directo.`;
          try {
            await sendWa(`whatsapp:+${directorPhone}`, msgDir);
            await logMessage(directorPhone, keyDir, e.folio, msgDir);
            escalados++;
          } catch (err: any) {
            errores.push(`critical-dir ${e.folio}: ${err.message}`);
          }
        }

        const keyProm = `abandono_promotor_${e.folio}`;
        const alreadyProm = await wasSentRecently(promotorPhone, keyProm, 24);
        if (!alreadyProm) {
          const msgProm = `🔴 Abandono ${e.diasSinRecaudo}d: *${e.folio}* (${e.cliente}) placa ${e.placa}. Tel: ${e.telefono || "N/A"}. Última carga: ${e.ultimaCarga}.`;
          try {
            await sendWa(`whatsapp:+${promotorPhone}`, msgProm);
            await logMessage(promotorPhone, keyProm, e.folio, msgProm);
          } catch (err: any) {
            errores.push(`critical-prom ${e.folio}: ${err.message}`);
          }
        }
      }
    } catch (err: any) {
      errores.push(`general ${e.folio}: ${err.message}`);
    }
  }

  return { notificados, escalados, errores };
}
