/**
 * Pipeline de Ventas — Tracking de prospectos por canal
 * 
 * Status flow: curioso → interesado → registrado → docs_parcial → docs_completo → evaluado → en_espera
 * Canales: ACATAXI, ORGANICO, [futuras agrupaciones]
 * Seguimiento automático: 3d frío, 5d sin docs, 7d incompleto
 */

import { neon } from "@neondatabase/serverless";

const getSQL = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("No DATABASE_URL");
  return neon(url);
};

// ===== CANAL DETECTION =====

const CANAL_KEYWORDS: Record<string, string[]> = {
  ACATAXI: ["acataxi", "cartel en acataxi", "poster acataxi", "vi el cartel"],
  CATALOGO: ["[catalogo]", "catalogo", "vi el inventario", "inventario en línea", "inventario en linea", "catalogo.conductores"],
};

export function detectCanal(message: string): string {
  const lower = message.toLowerCase();
  for (const [canal, keywords] of Object.entries(CANAL_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) return canal;
  }
  return "ORGANICO";
}

// ===== VALIDACIÓN DE DATOS DE PROSPECTO =====

/**
 * Decide si un registro de prospecto tiene datos "contactables" para follow-up.
 * Reglas del agente:
 *  - nombre existe y tiene al menos 2 chars alfabéticos consecutivos
 *  - nombre tiene entre 2 y 5 palabras (nombres normales: "Pedro", "Pedro López", "María José Sánchez")
 *  - nombre no es igual al teléfono
 *  - nombre no contiene signos de puntuación de oración (coma, ¿, ?, !, punto final extraño)
 *  - nombre no empieza con un número
 *  - teléfono válido (10-13 dígitos, no un número de prueba 521999*)
 */
export function isValidProspectForFollowup(p: { nombre?: string | null; phone?: string | null }): { ok: boolean; reason?: string } {
  const nombre = (p.nombre || "").trim();
  const phoneDigits = (p.phone || "").replace(/\D/g, "");

  if (!phoneDigits || phoneDigits.length < 10 || phoneDigits.length > 13) return { ok: false, reason: "PHONE_INVALID" };
  if (phoneDigits.startsWith("521999")) return { ok: false, reason: "PHONE_TEST" };

  if (!nombre) return { ok: false, reason: "NAME_EMPTY" };
  if (/^\d/.test(nombre)) return { ok: false, reason: "NAME_STARTS_WITH_DIGIT" };
  if (nombre.replace(/\D/g, "") === phoneDigits) return { ok: false, reason: "NAME_IS_PHONE" };

  const words = nombre.split(/\s+/).filter(w => w.length > 0);
  if (words.length < 1 || words.length > 5) return { ok: false, reason: "NAME_WORD_COUNT" };
  if (/[,¿?¡!]/.test(nombre)) return { ok: false, reason: "NAME_HAS_PUNCTUATION" };
  // Debe haber al menos 2 letras consecutivas en el nombre
  if (!/[A-Za-zÀ-ÿ]{2,}/.test(nombre)) return { ok: false, reason: "NAME_NO_LETTERS" };
  // Longitud total razonable (nombre real: 3-50 chars)
  if (nombre.length < 3 || nombre.length > 50) return { ok: false, reason: "NAME_LENGTH" };

  return { ok: true };
}

/**
 * Marca como 'invalido' los prospectos con datos basura. No se borran (para auditoría),
 * pero el cron los ignora. Devuelve el número de marcados + detalle.
 */
export async function markInvalidProspects(opts: { dryRun?: boolean } = {}): Promise<{
  total: number;
  marcados: number;
  detalle: Array<{ phone: string; nombre: string | null; reason: string }>;
}> {
  const sql = getSQL();
  const rows = await sql`
    SELECT phone, nombre, status FROM prospects_pipeline
    WHERE status NOT IN ('invalido', 'firmado', 'rechazado', 'descartado')
  ` as any[];

  const detalle: Array<{ phone: string; nombre: string | null; reason: string }> = [];
  for (const r of rows) {
    const check = isValidProspectForFollowup({ nombre: r.nombre, phone: r.phone });
    if (!check.ok) {
      detalle.push({ phone: r.phone, nombre: r.nombre, reason: check.reason || "UNKNOWN" });
      if (!opts.dryRun) {
        await sql`
          UPDATE prospects_pipeline
          SET status = 'invalido', notas = COALESCE(notas, '') || ${`[auto-marcado invalido: ${check.reason} @ ${new Date().toISOString().slice(0,10)}] `}
          WHERE phone = ${r.phone}
        `;
      }
    }
  }

  return { total: rows.length, marcados: detalle.length, detalle };
}

// ===== PROSPECT CRUD =====

export async function upsertProspect(data: {
  phone: string;
  canal_origen?: string;
  nombre?: string;
  status?: string;
  fuel_type?: string;
  consumo_mensual?: number;
  ahorro_estimado?: number;
  diferencial_estimado?: number;
  folio_id?: string;
}): Promise<any> {
  const sql = getSQL();

  // Sanitize nombre antes de guardar. Si el "nombre" recibido parece basura
  // (saludo, mensaje con puntuación, teléfono, demasiado largo/corto), lo descartamos
  // en lugar de persistirlo. El prospecto se crea/actualiza sin nombre — se puede
  // capturar después en el flujo correcto (prospect_awaiting_name).
  if (data.nombre) {
    // Valido solo las reglas de nombre (usamos un teléfono dummy válido
    // para que la validación solo falle por problemas del nombre).
    const nameCheck = isValidProspectForFollowup({ nombre: data.nombre, phone: "5544332211" });
    if (!nameCheck.ok && nameCheck.reason?.startsWith("NAME_")) {
      console.warn(`[Pipeline] upsertProspect nombre rechazado para ${data.phone}: "${data.nombre}" (${nameCheck.reason})`);
      delete data.nombre; // descartar, no persistir basura
    }
  }

  const existing = await sql`SELECT * FROM prospects_pipeline WHERE phone = ${data.phone}`;
  
  if (existing.length > 0) {
    // Update
    const updates: any = { updated_at: new Date().toISOString(), ultimo_contacto: new Date().toISOString() };
    if (data.nombre) updates.nombre = data.nombre;
    if (data.status) updates.status = data.status;
    if (data.fuel_type) updates.fuel_type = data.fuel_type;
    if (data.consumo_mensual) updates.consumo_mensual = data.consumo_mensual;
    if (data.ahorro_estimado) updates.ahorro_estimado = data.ahorro_estimado;
    if (data.diferencial_estimado) updates.diferencial_estimado = data.diferencial_estimado;
    if (data.folio_id) updates.folio_id = data.folio_id;
    
    await sql`
      UPDATE prospects_pipeline SET
        nombre = COALESCE(${updates.nombre || null}, nombre),
        status = COALESCE(${updates.status || null}, status),
        fuel_type = COALESCE(${updates.fuel_type || null}, fuel_type),
        consumo_mensual = COALESCE(${updates.consumo_mensual || null}, consumo_mensual),
        ahorro_estimado = COALESCE(${updates.ahorro_estimado || null}, ahorro_estimado),
        diferencial_estimado = COALESCE(${updates.diferencial_estimado || null}, diferencial_estimado),
        folio_id = COALESCE(${updates.folio_id || null}, folio_id),
        ultimo_contacto = NOW(),
        updated_at = NOW()
      WHERE phone = ${data.phone}
    `;
    return { ...existing[0], ...updates };
  } else {
    // Insert
    const result = await sql`
      INSERT INTO prospects_pipeline (phone, canal_origen, nombre, status, fuel_type, consumo_mensual, ahorro_estimado, diferencial_estimado, folio_id)
      VALUES (${data.phone}, ${data.canal_origen || "ORGANICO"}, ${data.nombre || null}, ${data.status || "curioso"}, ${data.fuel_type || null}, ${data.consumo_mensual || null}, ${data.ahorro_estimado || null}, ${data.diferencial_estimado || null}, ${data.folio_id || null})
      RETURNING *
    `;
    // Update canal count
    if (data.canal_origen) {
      await sql`UPDATE canales_venta SET prospectos_count = prospectos_count + 1 WHERE codigo = ${data.canal_origen}`.catch(() => {});
    }
    return result[0];
  }
}

export async function updateProspectStatus(phone: string, status: string): Promise<void> {
  const sql = getSQL();
  await sql`UPDATE prospects_pipeline SET status = ${status}, updated_at = NOW(), ultimo_contacto = NOW() WHERE phone = ${phone}`;
}

export async function updateProspectDocs(phone: string, docsCompleted: number, docsTotal: number): Promise<void> {
  const sql = getSQL();
  const status = docsCompleted >= docsTotal ? "docs_completo" : "docs_parcial";
  await sql`UPDATE prospects_pipeline SET docs_completados = ${docsCompleted}, docs_total = ${docsTotal}, status = ${status}, updated_at = NOW() WHERE phone = ${phone}`;
}

// ===== PIPELINE QUERIES =====

export async function getPipelineStats(): Promise<{
  total: number;
  by_status: Record<string, number>;
  by_canal: Record<string, number>;
  stale_3d: number;
  stale_5d: number;
  stale_7d: number;
}> {
  const sql = getSQL();
  
  const all = await sql`SELECT status, canal_origen, ultimo_contacto FROM prospects_pipeline`;
  const now = Date.now();
  
  const by_status: Record<string, number> = {};
  const by_canal: Record<string, number> = {};
  let stale_3d = 0, stale_5d = 0, stale_7d = 0;
  
  for (const p of all) {
    by_status[p.status] = (by_status[p.status] || 0) + 1;
    by_canal[p.canal_origen] = (by_canal[p.canal_origen] || 0) + 1;
    
    const days = (now - new Date(p.ultimo_contacto).getTime()) / (1000 * 60 * 60 * 24);
    if (days >= 7) stale_7d++;
    else if (days >= 5) stale_5d++;
    else if (days >= 3) stale_3d++;
  }
  
  return { total: all.length, by_status, by_canal, stale_3d, stale_5d, stale_7d };
}

export async function getPipelineList(options?: {
  canal?: string;
  status?: string;
  limit?: number;
}): Promise<any[]> {
  const sql = getSQL();
  const limit = options?.limit || 100;
  
  if (options?.canal && options?.status) {
    return sql`SELECT * FROM prospects_pipeline WHERE canal_origen = ${options.canal} AND status = ${options.status} ORDER BY created_at DESC LIMIT ${limit}`;
  }
  if (options?.canal) {
    return sql`SELECT * FROM prospects_pipeline WHERE canal_origen = ${options.canal} ORDER BY created_at DESC LIMIT ${limit}`;
  }
  if (options?.status) {
    return sql`SELECT * FROM prospects_pipeline WHERE status = ${options.status} ORDER BY created_at DESC LIMIT ${limit}`;
  }
  return sql`SELECT * FROM prospects_pipeline ORDER BY created_at DESC LIMIT ${limit}`;
}

export async function getCanales(): Promise<any[]> {
  const sql = getSQL();
  return sql`SELECT * FROM canales_venta WHERE activo = true ORDER BY prospectos_count DESC`;
}

// ===== SEGUIMIENTO AUTOMÁTICO =====

export async function getProspectsNeedingFollowup(): Promise<{
  frios_3d: any[];
  sin_docs_5d: any[];
  incompletos_7d: any[];
}> {
  const sql = getSQL();
  const now = new Date();
  const d3 = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const d5 = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  
  const frios_3d = await sql`
    SELECT * FROM prospects_pipeline 
    WHERE status IN ('curioso', 'interesado') 
    AND ultimo_contacto < ${d3}
    AND (ultimo_seguimiento IS NULL OR ultimo_seguimiento < ${d3})
    ORDER BY ultimo_contacto ASC LIMIT 20
  `;
  
  const sin_docs_5d = await sql`
    SELECT * FROM prospects_pipeline 
    WHERE status = 'registrado' 
    AND docs_completados = 0
    AND ultimo_contacto < ${d5}
    AND (ultimo_seguimiento IS NULL OR ultimo_seguimiento < ${d5})
    ORDER BY ultimo_contacto ASC LIMIT 20
  `;
  
  const incompletos_7d = await sql`
    SELECT * FROM prospects_pipeline 
    WHERE status = 'docs_parcial' 
    AND ultimo_contacto < ${d7}
    AND (ultimo_seguimiento IS NULL OR ultimo_seguimiento < ${d7})
    ORDER BY ultimo_contacto ASC LIMIT 20
  `;

  // Filtro de sanity: solo prospectos con nombre/teléfono válidos son contactables.
  // Los inválidos se mantienen en DB pero no se les manda follow-up.
  const filter = (rows: any[]) => rows.filter((r: any) => isValidProspectForFollowup({ nombre: r.nombre, phone: r.phone }).ok);

  return {
    frios_3d: filter(frios_3d as any[]),
    sin_docs_5d: filter(sin_docs_5d as any[]),
    incompletos_7d: filter(incompletos_7d as any[]),
  };
}

export async function markFollowupSent(phone: string): Promise<void> {
  const sql = getSQL();
  await sql`UPDATE prospects_pipeline SET ultimo_seguimiento = NOW() WHERE phone = ${phone}`;
}

// ===== QR / DEEP LINK GENERATION =====

export function generateWhatsAppLink(phone: string, canalCode: string, mensaje: string): string {
  // phone is the CMU WhatsApp number (without +)
  const encoded = encodeURIComponent(mensaje);
  return `https://wa.me/${phone}?text=${encoded}`;
}
