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
  
  return { frios_3d, sin_docs_5d, incompletos_7d };
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
