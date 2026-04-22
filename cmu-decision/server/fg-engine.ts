/**
 * Fondo de Garantia (FG) Engine
 *
 * Modelo oficial (22-abr-2026, confirmado con director):
 *  - Inicial: $8,000 (cobrado post-firma via Conekta, bloquea entrega del vehiculo)
 *  - Mensual: $334 (acumula al pagar cada cuota)
 *  - Techo: $20,000 (deja de cobrarse mensual al alcanzarlo)
 *  - Descuento: si GNV no cubre cuota y FG tiene saldo, se aplica ANTES de mora
 *  - Devolucion: al completar credito en regla, regresa hasta $20,000 al cliente
 *
 * Tabla fg_ledger guarda TODOS los movimientos:
 *   tipo: 'inicial' | 'mensual' | 'aplicado' | 'devuelto' | 'ajuste'
 *   Saldo actual = SUM(monto) WHERE folio=X (inicial/mensual/ajuste positivo, aplicado/devuelto negativo)
 *
 * Agnostico al producto (Joylong, Kit, TSR). Todo va al mismo ledger por folio.
 */

import { neon } from "@neondatabase/serverless";

export const FG_INICIAL = 8000;
export const FG_MENSUAL = 334;
export const FG_TECHO = 20000;

export type FGMovementType = "inicial" | "mensual" | "aplicado" | "devuelto" | "ajuste";

export interface FGMovement {
  id: number;
  folio: string;
  tipo: FGMovementType;
  monto: number; // siempre positivo; signo lo da `tipo`
  saldoAntes: number;
  saldoDespues: number;
  concepto: string;
  conektaCheckoutId?: string | null;
  refExterna?: string | null; // e.g. mes del cierre aplicado, tracking de devolucion
  createdAt: string;
  createdBy?: string | null;
}

function getSQL() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not configured");
  return neon(url);
}

/** Crea la tabla si no existe. Se llama una vez al arranque o antes de la 1era operación. */
export async function ensureFGTable(): Promise<void> {
  const sql = getSQL();
  await sql`
    CREATE TABLE IF NOT EXISTS fg_ledger (
      id SERIAL PRIMARY KEY,
      folio TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('inicial','mensual','aplicado','devuelto','ajuste')),
      monto NUMERIC(10,2) NOT NULL,
      saldo_antes NUMERIC(10,2) NOT NULL,
      saldo_despues NUMERIC(10,2) NOT NULL,
      concepto TEXT NOT NULL,
      conekta_checkout_id TEXT,
      ref_externa TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_fg_ledger_folio ON fg_ledger (folio)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_fg_ledger_created ON fg_ledger (created_at DESC)`;
  // Unique constraint para idempotencia del cobro inicial: solo 1 'inicial' por folio
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_fg_ledger_inicial_unique ON fg_ledger (folio) WHERE tipo = 'inicial'`;
  // Idempotencia de 'mensual': solo 1 mensual por (folio, ref_externa) — ref_externa = mes YYYY-MM
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_fg_ledger_mensual_unique ON fg_ledger (folio, ref_externa) WHERE tipo = 'mensual'`;
}

/** Saldo actual del FG para un folio. 0 si no hay movimientos. */
export async function getSaldoFG(folio: string): Promise<number> {
  const sql = getSQL();
  const rows = (await sql`
    SELECT saldo_despues FROM fg_ledger
    WHERE folio = ${folio}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `) as any[];
  return rows.length > 0 ? Number(rows[0].saldo_despues) : 0;
}

/** Historial completo. */
export async function getHistorialFG(folio: string): Promise<FGMovement[]> {
  const sql = getSQL();
  const rows = (await sql`
    SELECT * FROM fg_ledger WHERE folio = ${folio} ORDER BY created_at ASC, id ASC
  `) as any[];
  return rows.map((r) => ({
    id: r.id,
    folio: r.folio,
    tipo: r.tipo,
    monto: Number(r.monto),
    saldoAntes: Number(r.saldo_antes),
    saldoDespues: Number(r.saldo_despues),
    concepto: r.concepto,
    conektaCheckoutId: r.conekta_checkout_id,
    refExterna: r.ref_externa,
    createdAt: r.created_at,
    createdBy: r.created_by,
  }));
}

async function insertMovement(params: {
  folio: string;
  tipo: FGMovementType;
  monto: number; // siempre positivo
  concepto: string;
  conektaCheckoutId?: string | null;
  refExterna?: string | null;
  createdBy?: string | null;
}): Promise<FGMovement> {
  const sql = getSQL();
  const saldoAntes = await getSaldoFG(params.folio);
  const delta = (params.tipo === "aplicado" || params.tipo === "devuelto") ? -Math.abs(params.monto) : Math.abs(params.monto);
  const saldoDespues = Math.max(0, saldoAntes + delta);

  const rows = (await sql`
    INSERT INTO fg_ledger (folio, tipo, monto, saldo_antes, saldo_despues, concepto, conekta_checkout_id, ref_externa, created_by)
    VALUES (${params.folio}, ${params.tipo}, ${Math.abs(params.monto)}, ${saldoAntes}, ${saldoDespues},
            ${params.concepto}, ${params.conektaCheckoutId || null}, ${params.refExterna || null}, ${params.createdBy || "system"})
    RETURNING *
  `) as any[];
  const r = rows[0];
  return {
    id: r.id, folio: r.folio, tipo: r.tipo, monto: Number(r.monto),
    saldoAntes: Number(r.saldo_antes), saldoDespues: Number(r.saldo_despues),
    concepto: r.concepto, conektaCheckoutId: r.conekta_checkout_id, refExterna: r.ref_externa,
    createdAt: r.created_at, createdBy: r.created_by,
  };
}

// ===== CAPA 2: Cobro inicial =====

/** Registra el pago inicial de $8,000. Idempotente: si ya existe, no duplica. */
export async function registrarFGInicial(folio: string, monto: number, conektaCheckoutId: string | null): Promise<{ success: boolean; movement?: FGMovement; error?: string }> {
  try {
    await ensureFGTable();
    const sql = getSQL();
    const existing = (await sql`SELECT id FROM fg_ledger WHERE folio = ${folio} AND tipo = 'inicial'`) as any[];
    if (existing.length > 0) {
      return { success: false, error: `FG inicial ya registrado para ${folio} (id=${existing[0].id})` };
    }
    const mov = await insertMovement({
      folio, tipo: "inicial", monto, concepto: "Fondo de Garantia inicial post-firma",
      conektaCheckoutId, refExterna: "post_firma",
    });
    return { success: true, movement: mov };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ===== CAPA 3: Acumulación mensual =====

/**
 * Suma $334 al FG por cuota pagada, hasta el techo de $20,000.
 * Idempotente por (folio, mes YYYY-MM). Si ya se acumuló ese mes, no duplica.
 * Devuelve monto efectivamente acumulado (puede ser <334 si se tope el techo).
 */
export async function acumularFGMensual(folio: string, mes: string, concepto = ""): Promise<{ success: boolean; acumulado: number; saldoDespues: number; error?: string }> {
  try {
    await ensureFGTable();
    const saldoActual = await getSaldoFG(folio);
    if (saldoActual >= FG_TECHO) {
      return { success: true, acumulado: 0, saldoDespues: saldoActual };
    }
    const espacioDisponible = FG_TECHO - saldoActual;
    const aAcumular = Math.min(FG_MENSUAL, espacioDisponible);
    const mov = await insertMovement({
      folio, tipo: "mensual", monto: aAcumular,
      concepto: concepto || `Acumulacion FG mensual ${mes}`,
      refExterna: mes,
    });
    return { success: true, acumulado: aAcumular, saldoDespues: mov.saldoDespues };
  } catch (e: any) {
    if (String(e.message).includes("idx_fg_ledger_mensual_unique")) {
      // Ya se acumuló ese mes
      const saldo = await getSaldoFG(folio);
      return { success: true, acumulado: 0, saldoDespues: saldo, error: "Ya acumulado este mes" };
    }
    return { success: false, acumulado: 0, saldoDespues: 0, error: e.message };
  }
}

// ===== CAPA 4: Descuento automático =====

/**
 * Aplica FG para cubrir un diferencial de cuota.
 * Devuelve cuánto cubrió el FG + deuda restante.
 */
export async function aplicarFG(folio: string, deudaMonto: number, mesRef: string): Promise<{ success: boolean; aplicado: number; deudaRestante: number; saldoDespues: number; error?: string }> {
  try {
    await ensureFGTable();
    const saldoActual = await getSaldoFG(folio);
    if (saldoActual <= 0) {
      return { success: true, aplicado: 0, deudaRestante: deudaMonto, saldoDespues: 0 };
    }
    const aAplicar = Math.min(saldoActual, deudaMonto);
    const mov = await insertMovement({
      folio, tipo: "aplicado", monto: aAplicar,
      concepto: `FG aplicado para cubrir diferencial de cuota ${mesRef}`,
      refExterna: mesRef,
    });
    return { success: true, aplicado: aAplicar, deudaRestante: deudaMonto - aAplicar, saldoDespues: mov.saldoDespues };
  } catch (e: any) {
    return { success: false, aplicado: 0, deudaRestante: deudaMonto, saldoDespues: 0, error: e.message };
  }
}

// ===== CAPA 5: Devolución =====

/** Marca una devolución completa al completar el crédito. */
export async function registrarDevolucionFG(folio: string, conceptoExtra?: string): Promise<{ success: boolean; devuelto: number; error?: string }> {
  try {
    await ensureFGTable();
    const saldo = await getSaldoFG(folio);
    if (saldo <= 0) {
      return { success: true, devuelto: 0 };
    }
    await insertMovement({
      folio, tipo: "devuelto", monto: saldo,
      concepto: conceptoExtra ? `Devolucion FG: ${conceptoExtra}` : "Devolucion FG al completar credito",
      refExterna: "credito_completado",
    });
    return { success: true, devuelto: saldo };
  } catch (e: any) {
    return { success: false, devuelto: 0, error: e.message };
  }
}

// ===== Helper: ajuste manual (para reconciliación retroactiva) =====

export async function ajusteManualFG(folio: string, monto: number, concepto: string, createdBy = "director"): Promise<{ success: boolean; movement?: FGMovement; error?: string }> {
  try {
    await ensureFGTable();
    const mov = await insertMovement({
      folio, tipo: "ajuste", monto, concepto: `[AJUSTE MANUAL] ${concepto}`,
      refExterna: null, createdBy,
    });
    return { success: true, movement: mov };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}
