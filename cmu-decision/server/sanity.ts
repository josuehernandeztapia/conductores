/**
 * Sanity Engine — defensive checks BEFORE any outbound action involving $$$.
 *
 * Filosofía: el agente debe pensar antes de actuar. Cada función aquí
 * responde una pregunta específica que un humano competente se haría:
 *
 *  - ¿Tengo todos los datos que debería tener para este periodo?
 *  - ¿Los números cuadran con lo que ya tenía?
 *  - ¿El cambio es plausible o es un salto sospechoso?
 *  - ¿Estoy a punto de mandarle a un humano real algo incorrecto?
 *
 * Uso típico:
 *
 *   const s = await sanityCheckAvisoRecaudo({ folio, cliente, ... });
 *   if (!s.ok) {
 *     await reportSanityFailure("avisoRecaudoDia25", s, sendWa);
 *     return; // abort, no envío
 *   }
 *
 * Cuando algún check falla, genera un reporte estructurado que se manda
 * al director (JOSUE_PHONE) con diagnóstico preciso — no mensaje genérico.
 */

import { neon } from "@neondatabase/serverless";

const AIRTABLE_BASE = "appXxbjjGzXFiX7gk";
const TABLE_CREDITOS = "tblA62WNhSb4xYfYv";
const TABLE_PAGOS = "tbl5RiGyVgeE4EVfE";
const TABLE_AHORRO_JOYLONG = "tblUjkOQ2rWvBRRmw";
const TABLE_KIT_CONVERSION = "tbletXmlYRwisBcaO";
const TABLE_RECAUDO = "tblSUWmIE8Ma5be9u";

// ===== Tipos =====

export type SanityLevel = "error" | "warning" | "info";

export interface SanityIssue {
  level: SanityLevel;
  code: string; // machine-readable, e.g. "MISSING_WEEK_FILE"
  message: string; // human-readable explanation
  context?: Record<string, any>;
}

export interface SanityResult {
  ok: boolean; // true si no hay errores (warnings SÍ permiten pasar)
  issues: SanityIssue[];
  context?: Record<string, any>;
}

function emptyOk(): SanityResult {
  return { ok: true, issues: [] };
}

function fail(code: string, message: string, ctx?: any): SanityIssue {
  return { level: "error", code, message, context: ctx };
}

function warn(code: string, message: string, ctx?: any): SanityIssue {
  return { level: "warning", code, message, context: ctx };
}

// ===== Airtable helper (evitar círculo de imports) =====

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

// ===== 1) Meta-checks universales (nombre, teléfono, monto) =====

/** Para cualquier outbound: teléfono válido, nombre válido, no es test. */
export function sanityCheckTarget(target: { nombre?: string; telefono?: string; folio?: string }): SanityResult {
  const issues: SanityIssue[] = [];
  const nombre = (target.nombre || "").trim();
  const tel = (target.telefono || "").replace(/[^0-9]/g, "");
  const folio = (target.folio || "").trim();

  if (!nombre) issues.push(fail("MISSING_NAME", "El destinatario no tiene nombre cargado."));
  if (/TEST|PRUEBA|DEMO|DUMMY/i.test(nombre))
    issues.push(fail("TEST_NAME_IN_PROD", `Nombre contiene 'TEST' o similar: "${nombre}". Abortando.`));

  if (!tel) issues.push(fail("MISSING_PHONE", "El destinatario no tiene teléfono cargado."));
  else if (tel.length < 10 || tel.length > 13)
    issues.push(fail("BAD_PHONE_LENGTH", `Teléfono con longitud inesperada (${tel.length} dígitos): "${tel}".`));
  else if (!tel.startsWith("52"))
    issues.push(warn("PHONE_WITHOUT_52", `Teléfono sin prefijo 52 (MX): "${tel}". Se anexará automáticamente.`));

  // Número del director reservado — nunca mandar mensaje automático al director como "cliente"
  if (tel === "5214422022540" || tel === "4422022540")
    issues.push(fail("TARGET_IS_DIRECTOR", "El destinatario es el teléfono del director. No puede ser cliente."));

  if (!folio) issues.push(warn("MISSING_FOLIO", "Sin folio asociado — dificulta trazabilidad."));
  else if (folio.includes("TEST")) issues.push(fail("TEST_FOLIO", `Folio de prueba: "${folio}". Abortando.`));

  return { ok: !issues.some((i) => i.level === "error"), issues };
}

/** Monto válido antes de incluirlo en cualquier mensaje. */
export function sanityCheckAmount(
  monto: number,
  ctx: { expectPositive?: boolean; maxReasonable?: number; label?: string } = {},
): SanityResult {
  const issues: SanityIssue[] = [];
  const label = ctx.label || "monto";

  if (monto === null || monto === undefined || Number.isNaN(monto))
    issues.push(fail("AMOUNT_NAN", `${label} es NaN/null.`));
  else if (monto < 0) issues.push(fail("AMOUNT_NEGATIVE", `${label} es negativo: $${monto}.`));
  else if (ctx.expectPositive && monto === 0)
    issues.push(fail("AMOUNT_ZERO", `${label} es 0 pero se esperaba > 0.`));
  else if (ctx.maxReasonable && monto > ctx.maxReasonable)
    issues.push(
      fail("AMOUNT_EXCEEDS_LIMIT", `${label} ($${monto.toLocaleString()}) excede el límite razonable ($${ctx.maxReasonable.toLocaleString()}). Posible bug de unidades (centavos vs pesos).`),
    );

  return { ok: !issues.some((i) => i.level === "error"), issues };
}

// ===== 2) Completitud de datos de entrada (recaudo) =====

/**
 * Verifica que todos los archivos de recaudo esperados para un periodo
 * hayan sido procesados. Si falta alguno, avisa con detalle.
 *
 * expectedWeeks: lista de identificadores de semana (ej: ["S12","S13","S14A","S14B","S15","S16"])
 */
export async function sanityCheckRecaudoCompleteness(expectedWeeks: string[]): Promise<SanityResult> {
  const issues: SanityIssue[] = [];
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    issues.push(warn("NO_DB", "DATABASE_URL no disponible, no puedo verificar dedup table."));
    return { ok: false, issues };
  }
  try {
    const sql = neon(dbUrl);
    const rows = (await sql`SELECT sha256, filename, processed_at FROM processed_files ORDER BY processed_at DESC LIMIT 200`) as any[];
    const filenames = rows.map((r) => (r.filename || "").toUpperCase());

    const missing: string[] = [];
    for (const w of expectedWeeks) {
      const found = filenames.some((f) => f.includes(w.toUpperCase()));
      if (!found) missing.push(w);
    }

    if (missing.length > 0) {
      issues.push(
        fail(
          "MISSING_WEEK_FILES",
          `Faltan ${missing.length}/${expectedWeeks.length} archivos: ${missing.join(", ")}. No puedo calcular acumulado correcto.`,
          { missing, processedRecent: filenames.slice(0, 10) },
        ),
      );
    }
  } catch (e: any) {
    issues.push(warn("DEDUP_READ_FAIL", `No se pudo leer processed_files: ${e.message}`));
  }
  return { ok: !issues.some((i) => i.level === "error"), issues };
}

// ===== 3) Consistencia Airtable: Ahorro Acumulado vs suma de Pagos =====

/**
 * Para un cliente Joylong, verifica que el campo `Ahorro Acumulado` del
 * record cuadre con la suma de registros en tabla Pagos. Si no cuadra,
 * hay drift y no se debe mandar mensaje con el acumulado "oficial".
 *
 * Tolerancia: ±$50 (redondeos).
 */
export async function sanityCheckAhorroConsistency(folio: string, ahorroAirtable: number): Promise<SanityResult> {
  const issues: SanityIssue[] = [];
  try {
    const pagos = await airtableFetch(TABLE_PAGOS, {
      filterByFormula: `{Folio}="${folio}"`,
    });
    const sumaPagos = pagos.reduce((acc: number, p: any) => acc + (Number(p.Monto) || 0), 0);
    const delta = Math.abs(ahorroAirtable - sumaPagos);

    if (delta > 50) {
      issues.push(
        fail(
          "AHORRO_PAGOS_MISMATCH",
          `Drift en ${folio}: Ahorro Acumulado Airtable = $${ahorroAirtable.toLocaleString()}, suma real Pagos = $${sumaPagos.toLocaleString()}, delta = $${delta.toLocaleString()}.`,
          { ahorroAirtable, sumaPagos, delta, pagosCount: pagos.length },
        ),
      );
    } else if (pagos.length === 0 && ahorroAirtable > 0) {
      issues.push(
        fail(
          "AHORRO_WITHOUT_PAGOS",
          `${folio} tiene Ahorro Acumulado $${ahorroAirtable.toLocaleString()} pero 0 registros en Pagos.`,
        ),
      );
    }
  } catch (e: any) {
    issues.push(warn("PAGOS_QUERY_FAIL", `No pude verificar consistencia Pagos para ${folio}: ${e.message}`));
  }
  return { ok: !issues.some((i) => i.level === "error"), issues };
}

// ===== 4) Delta sospechoso vs último mensaje enviado =====

/**
 * Compara el monto que está a punto de enviarse con el último monto
 * que se le envió al mismo cliente en el mismo contexto. Si el delta
 * supera el threshold (%), flag.
 *
 * Busca en la tabla `proactive_messages` por phone + messageType.
 */
export async function sanityCheckDeltaVsHistory(
  phone: string,
  messageType: string,
  currentAmount: number,
  opts: { thresholdPct?: number; lookbackDays?: number } = {},
): Promise<SanityResult> {
  const issues: SanityIssue[] = [];
  const threshold = opts.thresholdPct ?? 30;
  const lookback = opts.lookbackDays ?? 45;

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return emptyOk();

  try {
    const sql = neon(dbUrl);
    const rows = (await sql`
      SELECT message_text, sent_at FROM proactive_messages
      WHERE phone = ${phone} AND message_type = ${messageType}
        AND sent_at > NOW() - (${lookback} || ' days')::interval
      ORDER BY sent_at DESC LIMIT 1
    `) as any[];

    if (rows.length === 0) return emptyOk(); // primer mensaje, nada con qué comparar
    const prevText = String(rows[0].message_text || "");

    // Parsear el monto previo buscando el primer "$NNN,NNN" en el mensaje
    const m = prevText.match(/\$(\d{1,3}(?:,\d{3})*(?:\.\d+)?)/);
    if (!m) return emptyOk();
    const prevAmount = parseFloat(m[1].replace(/,/g, ""));
    if (prevAmount === 0) return emptyOk();

    const deltaPct = Math.abs(((currentAmount - prevAmount) / prevAmount) * 100);
    if (deltaPct > threshold) {
      issues.push(
        warn(
          "AMOUNT_JUMP",
          `Monto saltó ${deltaPct.toFixed(0)}% vs último mensaje (${prevAmount.toLocaleString()} → ${currentAmount.toLocaleString()}). Threshold: ${threshold}%.`,
          { prevAmount, currentAmount, deltaPct, sentAt: rows[0].sent_at },
        ),
      );
    }
  } catch {
    /* non-blocking */
  }
  return { ok: !issues.some((i) => i.level === "error"), issues };
}

// ===== 5) Última carga de GNV: cliente activo vs abandonado =====

/**
 * Si el cliente no ha tenido cargas en los últimos N días, flag — es
 * sospechoso enviar un aviso de ahorro si ya no está cargando.
 */
export async function sanityCheckRecentActivity(folio: string, withinDays = 14): Promise<SanityResult> {
  const issues: SanityIssue[] = [];
  try {
    const pagos = await airtableFetch(TABLE_PAGOS, {
      filterByFormula: `{Folio}="${folio}"`,
      "sort[0][field]": "Fecha Pago",
      "sort[0][direction]": "desc",
      maxRecords: "1",
    });
    if (pagos.length === 0) {
      issues.push(warn("NO_PAGOS", `${folio}: no hay pagos/cargas registradas nunca.`));
      return { ok: true, issues };
    }
    const fecha = pagos[0]["Fecha Pago"] || pagos[0].Fecha;
    if (!fecha) return emptyOk();
    const diasDesde = Math.floor((Date.now() - new Date(fecha).getTime()) / (1000 * 60 * 60 * 24));
    if (diasDesde > withinDays) {
      issues.push(
        warn(
          "INACTIVE_CLIENT",
          `${folio}: última carga hace ${diasDesde} días (${fecha}). Cliente posiblemente abandonado.`,
          { diasDesde, ultimaFecha: fecha },
        ),
      );
    }
  } catch {
    /* non-blocking */
  }
  return { ok: !issues.some((i) => i.level === "error"), issues };
}

// ===== 6) Checks compuestos por caso de uso =====

/**
 * Sanity completo para aviso día 25 de Joylong Ahorro.
 * Corre los checks universales + completitud de recaudo + drift + delta.
 */
export async function sanityCheckJoylongAviso(input: {
  folio: string;
  cliente: string;
  telefono: string;
  acumuladoAirtable: number;
  expectedWeeks: string[]; // semanas que deberían estar procesadas
}): Promise<SanityResult> {
  const allIssues: SanityIssue[] = [];

  const target = sanityCheckTarget({ nombre: input.cliente, telefono: input.telefono, folio: input.folio });
  allIssues.push(...target.issues);

  const amount = sanityCheckAmount(input.acumuladoAirtable, {
    expectPositive: false,
    maxReasonable: 900_000,
    label: `Ahorro Acumulado ${input.folio}`,
  });
  allIssues.push(...amount.issues);

  const completeness = await sanityCheckRecaudoCompleteness(input.expectedWeeks);
  allIssues.push(...completeness.issues);

  const consistency = await sanityCheckAhorroConsistency(input.folio, input.acumuladoAirtable);
  allIssues.push(...consistency.issues);

  const activity = await sanityCheckRecentActivity(input.folio, 21);
  allIssues.push(...activity.issues);

  const tel = (input.telefono || "").replace(/[^0-9]/g, "");
  const delta = await sanityCheckDeltaVsHistory(tel, `aviso_dia25_${input.folio}`, input.acumuladoAirtable, {
    thresholdPct: 50, // un jump >50% mensual es sospechoso en ahorro acumulado
  });
  allIssues.push(...delta.issues);

  return { ok: !allIssues.some((i) => i.level === "error"), issues: allIssues };
}

// ===== 7) Formateo del reporte cuando algo falla =====

/** Genera un mensaje WhatsApp al director explicando QUÉ se abortó y POR QUÉ. */
export function formatSanityFailureForDirector(
  source: string,
  issues: SanityIssue[],
  context?: Record<string, any>,
): string {
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const lines: string[] = [];

  lines.push(`[SANITY FAIL] *${source}* abortado.`);
  if (context?.folio) lines.push(`Folio: ${context.folio}${context.cliente ? ` (${context.cliente})` : ""}`);
  lines.push("");

  if (errors.length > 0) {
    lines.push(`*Errores (${errors.length}):*`);
    errors.forEach((e) => lines.push(`- [${e.code}] ${e.message}`));
  }
  if (warnings.length > 0) {
    lines.push("");
    lines.push(`*Warnings (${warnings.length}):*`);
    warnings.forEach((w) => lines.push(`- [${w.code}] ${w.message}`));
  }

  lines.push("");
  lines.push("No se envió nada al cliente. Revisa, corrige, re-corre.");
  return lines.join("\n");
}

/** Mismo reporte en forma estructurada (para logs/endpoints). */
export function sanityResultToJson(source: string, result: SanityResult, context?: Record<string, any>) {
  return {
    source,
    ok: result.ok,
    errorCount: result.issues.filter((i) => i.level === "error").length,
    warningCount: result.issues.filter((i) => i.level === "warning").length,
    issues: result.issues,
    context: context || result.context,
    timestamp: new Date().toISOString(),
  };
}
