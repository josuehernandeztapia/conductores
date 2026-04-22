/**
 * Cierre Mensual — Cobranza Perfecta (COB-01 a COB-04)
 * 
 * Runs on day 1 of each month. For each active taxi credit:
 * 1. Sum RecaudoGNV for the month
 * 2. Calculate cuota (German amortization, prorated if month 1)
 * 3. Diferencial = cuota - recaudo
 * 4. Generate Conekta payment link (diferencial + $334 FG)
 * 5. Send WhatsApp to taxista with breakdown + link
 * 6. Create Cierre Mensual record in Airtable
 * 
 * Day 5: reminder before FG
 * Day 6: FG kicks in if unpaid
 * Day 8: recargo applied ($250 + 2%)
 * Day 15: escalate to Josue
 * Day 30: recovery process
 */

import { crearLigaPago, cancelarLiga, isConektaEnabled } from "./conekta-client";
import { sendTemplate, sendFreeform, TEMPLATES } from "./whatsapp-templates";

const AIRTABLE_PAT = () => process.env.AIRTABLE_PAT || "";
const AIRTABLE_BASE = "appXxbjjGzXFiX7gk";
import { JOSUE_PHONE } from "./team-config";
const WA_SEND_URL = "https://cmu-originacion.fly.dev/api/whatsapp/send-outbound";

// Table IDs
const TABLE_CREDITOS = "tblA62WNhSb4xYfYv";
const TABLE_RECAUDO = "tblSUWmIE8Ma5be9u";
const TABLE_CIERRES = "tblVFP0kXEmvD6EZS";
const TABLE_AMORTIZACION = "tblWMvUwwdSKyKPSv";
const TABLE_PAGOS = "tbl5RiGyVgeE4EVfE";

// Business rules
const FG_MENSUAL = 334;
const FG_TECHO = 20000;
const MORA_FEE = 250;
const MORA_PCT = 0.02; // 2% monthly on unpaid diferencial
const MESES_RESCISION = 3;

// ===== AIRTABLE HELPERS =====

async function atFetch(tableId: string, params: Record<string, string> = {}): Promise<any[]> {
  const token = AIRTABLE_PAT();
  if (!token) return [];
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}${qs ? "?" + qs : ""}`;
  const res = await fetch(url, { headers: { "Authorization": `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) { console.error(`[Cierre] Airtable ${res.status}`); return []; }
  const data = await res.json();
  return (data.records || []).map((r: any) => ({ _id: r.id, ...r.fields }));
}

async function atCreate(tableId: string, fields: Record<string, any>): Promise<any> {
  const token = AIRTABLE_PAT();
  if (!token) return null;
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }] }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  return data.records?.[0] || null;
}

async function atUpdate(tableId: string, recordId: string, fields: Record<string, any>): Promise<void> {
  const token = AIRTABLE_PAT();
  if (!token) return;
  await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}/${recordId}`, {
    method: "PATCH",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
    signal: AbortSignal.timeout(15000),
  });
}

// ===== WHATSAPP HELPER =====

async function sendWA(to: string, body: string): Promise<void> {
  try {
    await fetch(WA_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, body }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e: any) {
    console.error(`[Cierre] WhatsApp send error (${to}):`, e.message);
  }
}

// ===== AMORTIZATION (German) =====

/**
 * German amortization: fixed capital, decreasing interest, decreasing payment.
 * Capital = total / plazo (fixed each month)
 * Interest = remaining_balance * monthly_rate
 * Payment = capital + interest (decreases each month)
 */
function calcCuotaAlemana(precioPlazos: number, plazo: number, tasaAnual: number, mes: number): { cuota: number; capital: number; interes: number; saldoPost: number } {
  const capitalFijo = precioPlazos / plazo;
  const tasaMensual = tasaAnual / 12;
  const saldoPre = precioPlazos - capitalFijo * (mes - 1);
  const interes = saldoPre * tasaMensual;
  const cuota = capitalFijo + interes;
  const saldoPost = saldoPre - capitalFijo;
  return { cuota: Math.round(cuota), capital: Math.round(capitalFijo), interes: Math.round(interes), saldoPost: Math.round(saldoPost) };
}

// ===== CIERRE MENSUAL =====

export type CierreResult = {
  creditosProcesados: number;
  detalle: Array<{
    folio: string;
    taxista: string;
    telefono: string;
    mes: number;
    cuota: number;
    recaudo: number;
    diferencial: number;
    cobroFG: number;
    totalLink: number;
    saldoFG: number;
  }>;
};

/**
 * Execute monthly close for all active taxi credits.
 * Called by cron on day 1 of each month.
 */
export async function ejecutarCierreMensual(): Promise<CierreResult> {
  const now = new Date();
  const mesActualCalendario = now.getMonth(); // 0-indexed (0=Jan)
  const anioActual = now.getFullYear();
  
  // Date for this cierre
  const fechaCierre = `${anioActual}-${String(mesActualCalendario + 1).padStart(2, "0")}-01`;
  const fechaLimite = `${anioActual}-${String(mesActualCalendario + 1).padStart(2, "0")}-05`;

  // Fase 1: Cierre de Taxi Seminuevo Renovacion (TSR) — tabla Creditos
  // Fase 2: Cierre de Kit Conversion (Elvira y similares) — tabla Kit Conversion
  const result: CierreResult = { creditosProcesados: 0, detalle: [] };
  await cerrarKitConversionMensual(result, anioActual, mesActualCalendario);

  // 1. Get all active taxi credits
  const creditos = await atFetch(TABLE_CREDITOS, {
    filterByFormula: `OR({Estatus}="Activo",{Estatus}="Mora Leve")`,
  });

  if (creditos.length === 0) {
    console.log("[Cierre] No active taxi credits found (TSR)");
    return result;
  }

  for (const credito of creditos) {
    const folio = credito.Folio;
    const mesCredito = (credito["Mes Actual"] || 0) + 1; // next month to close
    
    // Guard: only ONE cierre per folio per credit month. Period.
    const cierreExiste = await atFetch(TABLE_CIERRES, {
      filterByFormula: `AND({Folio}="${folio}",{Mes}=${mesCredito})`,
      maxRecords: "1",
    });
    if (cierreExiste.length > 0) {
      console.log(`[Cierre] ${folio} mes ${mesCredito} ya cerrado — skip`);
      continue;
    }
    
    // Also guard: don't close more than 1 month per execution
    // If Mes Actual was already advanced this run, skip
    if (mesCredito > 36) {
      console.log(`[Cierre] ${folio} mes ${mesCredito} > 36 — crédito terminado`);
      continue;
    }
    const telefono = credito.Telefono || "";
    const taxista = credito.Taxista || "?";
    const saldoFG = credito["Saldo FG"] || 0;
    const fechaFirma = credito["Fecha Firma"] || "";
    const precioPlazos = credito["Precio Plazos"] || credito["Precio Contado"] || 0;
    const plazo = 36;
    const tasaAnual = credito["Tasa Anual"] || 0.24; // 24% default

    // 2. Calculate cuota (German amortization)
    let { cuota } = calcCuotaAlemana(precioPlazos, plazo, tasaAnual, mesCredito);

    // Prorate month 1 if signed mid-month
    if (mesCredito === 1 && fechaFirma) {
      const firma = new Date(fechaFirma);
      const diaFirma = firma.getDate();
      const diasMes = new Date(firma.getFullYear(), firma.getMonth() + 1, 0).getDate();
      const diasActivos = diasMes - diaFirma + 1;
      const ratio = diasActivos / diasMes;
      cuota = Math.round(cuota * ratio);
      console.log(`[Cierre] ${folio} mes 1 prorrateado: firma día ${diaFirma}, ${diasActivos}/${diasMes} días, cuota $${cuota}`);
    }

    // 3. Sum RecaudoGNV for this month
    // Get all recaudo records for this folio in the current calendar month
    const recaudoRows = await atFetch(TABLE_RECAUDO, {
      filterByFormula: `AND({Folio}="${folio}",{Mes}=${mesCredito})`,
    });
    const recaudo = recaudoRows.reduce((s: number, r: any) => s + (r.Recaudo || 0), 0);

    // 4. Calculate diferencial
    const diferencial = Math.max(0, cuota - recaudo);

    // 5. FG aportación ($334 if not at ceiling)
    const cobroFG = saldoFG < FG_TECHO ? FG_MENSUAL : 0;

    // 6. Total link = diferencial + FG aportación
    const totalLink = diferencial + cobroFG;

    // 7. Generate Conekta payment link
    let linkUrl = "";
    let linkVigencia = fechaLimite;
    if (isConektaEnabled() && totalLink > 0) {
      const liga = await crearLigaPago({
        folio, mes: mesCredito, taxista, telefono,
        diferencial, cobroFG, vigenciaDias: 5,
      });
      if (liga.success && liga.url) {
        linkUrl = liga.url;
        linkVigencia = liga.expiresAt || fechaLimite;
      }
    }

    // 8. Create Cierre record
    await atCreate(TABLE_CIERRES, {
      "Folio": folio,
      "Mes": mesCredito,
      "Cuota": cuota,
      "Recaudo GNV": recaudo,
      "Diferencial": diferencial,
      "Cobro FG": cobroFG,
      "Total Link": totalLink,
      "FG Aplicado": 0,
      "Recargos": 0,
      "Estatus": "Pendiente Pago",
      "Fecha Cierre": fechaCierre,
      "Fecha Limite": fechaLimite,
      "Link Conekta": linkUrl,
      "Link Vigencia": linkVigencia,
      "Dias Atraso": 0,
      "Notas": `Cierre automático. Recaudo de ${recaudoRows.length} registros.`,
    });

    // 9. Do NOT advance Mes Actual here — it advances when payment is confirmed
    // This prevents double-execution from creating cierres for future months

    // 10. Send WhatsApp to taxista via template
    if (telefono && totalLink > 0) {
      await sendTemplate(telefono, "cierre_mensual", {
        "1": String(mesCredito),
        "2": taxista,
        "3": recaudo.toLocaleString(),
        "4": cuota.toLocaleString(),
        "5": diferencial.toLocaleString(),
        "6": String(cobroFG),
        "7": totalLink.toLocaleString(),
        "8": linkUrl || `CLABE: 152680120000787681 (Ref: ${folio})`,
      }, `Cierre mes ${mesCredito}: cuota $${cuota.toLocaleString()}, GNV $${recaudo.toLocaleString()}, diferencial $${diferencial.toLocaleString()}. Total: $${totalLink.toLocaleString()}. ${linkUrl || 'CLABE: 152680120000787681'}`);
    }

    result.creditosProcesados++;
    result.detalle.push({
      folio, taxista, telefono, mes: mesCredito,
      cuota, recaudo, diferencial, cobroFG, totalLink,
      saldoFG,
    });

    console.log(`[Cierre] ${folio} mes ${mesCredito}: cuota $${cuota}, recaudo $${recaudo}, dif $${diferencial}, link $${totalLink} ${linkUrl ? '(Conekta)' : '(CLABE)'}`);
  }

  // Notify director via template
  if (result.creditosProcesados > 0) {
    const resumen = formatCierreResumenDirector(result);
    await sendTemplate(JOSUE_PHONE, "cierre_resumen_director", {
      "1": String(result.creditosProcesados),
      "2": result.detalle.map(d => `${d.taxista} (${d.folio}) mes ${d.mes}: Cuota $${d.cuota.toLocaleString()} | GNV $${d.recaudo.toLocaleString()}`).join("\n"),
      "3": result.detalle.reduce((s, d) => s + d.cuota, 0).toLocaleString(),
      "4": result.detalle.reduce((s, d) => s + d.recaudo, 0).toLocaleString(),
    }, resumen);
  }

  return result;
}

// ===== DAY 3 REMINDER =====

/**
 * Day 3 reminder for unpaid cierres.
 */
export async function recordatorioDia3(): Promise<string[]> {
  const pendientes = await atFetch(TABLE_CIERRES, { filterByFormula: `{Estatus}="Pendiente Pago"` });
  const msgs: string[] = [];
  for (const c of pendientes) {
    const folio = c.Folio;
    const creditos = await atFetch(TABLE_CREDITOS, { filterByFormula: `{Folio}="${folio}"`, maxRecords: "1" });
    const telefono = creditos[0]?.Telefono || "";
    const linkUrl = c["Link Conekta"] || "";
    if (telefono) {
      await sendTemplate(telefono, "recordatorio_pago_dia3", {
        "1": (c["Total Link"] || 0).toLocaleString(),
        "2": linkUrl || `CLABE: 152680120000787681 (Ref: ${folio})`,
      });
      msgs.push(`${folio}: recordatorio enviado`);
    }
  }
  return msgs;
}

// ===== DAY 5 REMINDER (before FG) =====

/**
 * Day 5 last warning — tomorrow FG kicks in.
 */
export async function recordatorioDia5(): Promise<string[]> {
  const pendientes = await atFetch(TABLE_CIERRES, { filterByFormula: `{Estatus}="Pendiente Pago"` });
  const msgs: string[] = [];
  for (const c of pendientes) {
    const folio = c.Folio;
    const creditos = await atFetch(TABLE_CREDITOS, { filterByFormula: `{Folio}="${folio}"`, maxRecords: "1" });
    const telefono = creditos[0]?.Telefono || "";
    const linkUrl = c["Link Conekta"] || "";
    if (telefono) {
      await sendTemplate(telefono, "aviso_fg_dia5", {
        "1": (c.Diferencial || 0).toLocaleString(),
        "2": linkUrl || `CLABE: 152680120000787681 (Ref: ${folio})`,
      });
      msgs.push(`${folio}: aviso FG enviado`);
    }
  }
  return msgs;
}

// ===== FG APPLICATION (Day 6) =====

export type FGResult = {
  procesados: number;
  fgAplicados: number;
  moraActivada: number;
  detalle: Array<{
    folio: string;
    taxista: string;
    telefono: string;
    diferencial: number;
    fgDisponible: number;
    fgAplicado: number;
    deudaRestante: number;
    accion: string;
  }>;
};

/**
 * Apply FG for unpaid cierres (day 6).
 * Called by cron on day 6 of each month.
 */
export async function aplicarFGDia6(): Promise<FGResult> {
  // Find all cierres with Estatus="Pendiente Pago" for current month
  const pendientes = await atFetch(TABLE_CIERRES, {
    filterByFormula: `{Estatus}="Pendiente Pago"`,
  });

  const result: FGResult = { procesados: 0, fgAplicados: 0, moraActivada: 0, detalle: [] };

  // fg-engine es la fuente de verdad del saldo FG (tabla fg_ledger en Neon).
  // Airtable `Saldo FG` se mantiene como espejo informativo.
  const { getSaldoFG, aplicarFG } = await import("./fg-engine");

  for (const cierre of pendientes) {
    const folio = cierre.Folio;
    const diferencial = cierre.Diferencial || 0;

    // Get credit for client info (telefono, taxista)
    const creditos = await atFetch(TABLE_CREDITOS, {
      filterByFormula: `{Folio}="${folio}"`,
      maxRecords: "1",
    });
    if (creditos.length === 0) continue;
    const credito = creditos[0];
    const telefono = credito.Telefono || "";
    const taxista = credito.Taxista || "?";

    // Saldo real del FG: fg_ledger (no Airtable)
    const saldoFG = await getSaldoFG(folio);
    const mesRef = `${new Date().toISOString().slice(0,7)}-mes${cierre.Mes || 0}`;

    if (saldoFG >= diferencial) {
      // FG covers everything — descontar del ledger
      const fgOp = await aplicarFG(folio, diferencial, mesRef);
      const nuevoFG = fgOp.saldoDespues;
      await atUpdate(TABLE_CIERRES, cierre._id, {
        "Estatus": "FG Aplicado",
        "FG Aplicado": diferencial,
        "Metodo Pago": "FG",
        "Fecha Pago": new Date().toISOString().slice(0, 10),
      });
      const nuevoMesFG = Math.max(credito["Mes Actual"] || 0, cierre.Mes || 0);
      await atUpdate(TABLE_CREDITOS, credito._id, {
        "Mes Actual": nuevoMesFG,
        "Saldo FG": nuevoFG, // espejo informativo
        "Dias Atraso": 0,
      });
      if (telefono) await sendTemplate(telefono, "fg_aplicado", {
        "1": diferencial.toLocaleString(),
        "2": nuevoFG.toLocaleString(),
      });
      await sendFreeform(JOSUE_PHONE, `[FG] ${taxista} (${folio}): FG cubrio $${diferencial.toLocaleString()}. Saldo FG: $${nuevoFG.toLocaleString()}`);
      result.fgAplicados++;
      result.detalle.push({ folio, taxista, telefono, diferencial, fgDisponible: saldoFG, fgAplicado: diferencial, deudaRestante: 0, accion: `FG cubrió $${diferencial}. Saldo FG: $${nuevoFG}` });
    } else {
      // FG partial or zero — aplicar lo que haya y mandar resto a mora
      let fgAplicado = 0;
      if (saldoFG > 0) {
        const fgOp = await aplicarFG(folio, saldoFG, mesRef);
        fgAplicado = fgOp.aplicado;
      }
      const deudaRestante = diferencial - fgAplicado;
      await atUpdate(TABLE_CIERRES, cierre._id, {
        "Estatus": "Mora",
        "FG Aplicado": fgAplicado,
        "Dias Atraso": 1,
      });
      await atUpdate(TABLE_CREDITOS, credito._id, {
        "Saldo FG": 0,
        "Dias Atraso": 1,
        "Estatus": "Mora Leve",
      });
      // Generate new Conekta link for remaining debt
      let moraLinkUrl = "";
      if (isConektaEnabled() && deudaRestante > 0) {
        const liga = await crearLigaPago({ folio, mes: cierre.Mes, taxista, telefono, diferencial: deudaRestante, cobroFG: 0, vigenciaDias: 2 });
        if (liga.success && liga.url) moraLinkUrl = liga.url;
      }
      // WhatsApp: FG partial or zero, MORA
      const msgMora = fgAplicado > 0
        ? `Tu FG cubrio $${fgAplicado.toLocaleString()} pero faltaron $${deudaRestante.toLocaleString()}.\n${moraLinkUrl ? `Paga aqui: ${moraLinkUrl}` : `CLABE: 152680120000787681 (Ref: ${folio})`}\nTienes hasta el dia 8.`
        : `Tu FG esta agotado. Deuda pendiente: $${deudaRestante.toLocaleString()}.\n${moraLinkUrl ? `Paga aqui: ${moraLinkUrl}` : `CLABE: 152680120000787681 (Ref: ${folio})`}\nTienes hasta el dia 8.`;
      if (telefono) await sendTemplate(telefono, "mora_activa", {
        "1": "1",
        "2": deudaRestante.toLocaleString(),
        "3": moraLinkUrl || `CLABE: 152680120000787681 (Ref: ${folio})`,
      }, msgMora);
      await sendFreeform(JOSUE_PHONE, `[MORA] ${taxista} (${folio}): FG $${fgAplicado.toLocaleString()}, deuda $${deudaRestante.toLocaleString()}`);
      result.moraActivada++;
      result.detalle.push({ folio, taxista, telefono, diferencial, fgDisponible: saldoFG, fgAplicado, deudaRestante, accion: `FG cubrió $${fgAplicado}. MORA: $${deudaRestante} pendiente` });
    }
    result.procesados++;
  }

  return result;
}

// ===== DAILY MORA CHECK =====

export type MoraCheckResult = {
  enMora: number;
  acciones: Array<{
    folio: string;
    taxista: string;
    telefono: string;
    diasAtraso: number;
    deuda: number;
    recargos: number;
    accion: string;
  }>;
};

/**
 * Daily mora check — escalate based on days overdue.
 * Called by cron every day at 8:00 AM.
 */
export async function revisarMoraDiaria(): Promise<MoraCheckResult> {
  const cierresMora = await atFetch(TABLE_CIERRES, {
    filterByFormula: `{Estatus}="Mora"`,
  });

  const result: MoraCheckResult = { enMora: 0, acciones: [] };

  for (const cierre of cierresMora) {
    const folio = cierre.Folio;
    const diferencial = cierre.Diferencial || 0;
    const fgAplicado = cierre["FG Aplicado"] || 0;
    const deudaBase = diferencial - fgAplicado;
    const diasAtraso = (cierre["Dias Atraso"] || 0) + 1;

    // Calculate recargos
    let recargos = 0;
    if (diasAtraso >= 3) { // Day 8 = 3 days after day 6 mora start
      recargos = MORA_FEE + Math.round(deudaBase * MORA_PCT);
    }
    const deudaTotal = deudaBase + recargos;

    // Get credit info
    const creditos = await atFetch(TABLE_CREDITOS, {
      filterByFormula: `{Folio}="${folio}"`,
      maxRecords: "1",
    });
    const credito = creditos[0] || {};
    const taxista = credito.Taxista || "?";
    const telefono = credito.Telefono || "";

    // Determine action + send WhatsApp based on days
    let accion = "";
    if (diasAtraso === 3) {
      // Day 8: recargo applied, new liga
      recargos = MORA_FEE + Math.round(deudaBase * MORA_PCT);
      let liga3Url = "";
      if (isConektaEnabled()) {
        const liga = await crearLigaPago({ folio, mes: cierre.Mes || 0, taxista, telefono, diferencial: deudaTotal, cobroFG: 0, vigenciaDias: 7 });
        if (liga.success && liga.url) liga3Url = liga.url;
      }
      if (telefono) await sendTemplate(telefono, "recargo_mora", {
        "1": recargos.toLocaleString(),
        "2": deudaTotal.toLocaleString(),
        "3": liga3Url || `CLABE: 152680120000787681 (Ref: ${folio})`,
      });
      accion = `Recargo $${recargos}. Liga 3: $${deudaTotal}`;
    } else if (diasAtraso === 5) {
      // Day 10: last warning
      if (telefono) await sendTemplate(telefono, "ultimo_aviso", {
        "1": deudaTotal.toLocaleString(),
      }, `Ultimo aviso. Deuda: $${deudaTotal.toLocaleString()}.`);
      accion = "Último aviso antes de dirección";
    } else if (diasAtraso === 10) {
      // Day 15: escalate to Josué
      await sendTemplate(JOSUE_PHONE, "mora_15_dias", {
        "1": "15",
        "2": taxista,
        "3": folio,
        "4": deudaTotal.toLocaleString(),
      }, `MORA 15 DIAS: ${taxista} (${folio}) deuda $${deudaTotal.toLocaleString()}`);
      if (telefono) await sendTemplate(telefono, "mora_activa", {
        "1": "15",
        "2": deudaTotal.toLocaleString(),
        "3": "",
      }, `Tu cuenta tiene 15 dias de atraso. Deuda: $${deudaTotal.toLocaleString()}.`);
      accion = "ESCALADO A JOSUÉ — 15 días";
    } else if (diasAtraso >= 25) {
      await sendTemplate(JOSUE_PHONE, "mora_30_dias", {
        "1": String(diasAtraso),
        "2": taxista,
        "3": folio,
        "4": deudaTotal.toLocaleString(),
      }, `MORA 30+ DIAS: ${taxista} (${folio}) deuda $${deudaTotal.toLocaleString()}`);
      accion = "PROCESO DE RECUPERACIÓN — 30+ días";
    }

    // Update cierre
    await atUpdate(TABLE_CIERRES, cierre._id, {
      "Dias Atraso": diasAtraso,
      "Recargos": recargos,
    });
    await atUpdate(TABLE_CREDITOS, credito._id || "", {
      "Dias Atraso": diasAtraso,
    });

    // Check for rescision (3 consecutive months)
    if (diasAtraso >= 25) {
      // Check last 3 months
      const ultimosCierres = await atFetch(TABLE_CIERRES, {
        filterByFormula: `AND({Folio}="${folio}",{Estatus}="Mora")`,
      });
      if (ultimosCierres.length >= MESES_RESCISION) {
        accion = `RESCISIÓN — ${MESES_RESCISION} meses consecutivos sin pagar`;
      }
    }

    result.enMora++;
    result.acciones.push({ folio, taxista, telefono, diasAtraso, deuda: deudaTotal, recargos, accion });
  }

  return result;
}

// ===== PAYMENT REGISTRATION =====

/**
 * Register a payment for a cierre (from Conekta webhook or manual confirmation).
 */
export async function registrarPago(folio: string, mes: number, monto: number, metodo: string): Promise<{ success: boolean; message: string }> {
  // Find the cierre
  const cierres = await atFetch(TABLE_CIERRES, {
    filterByFormula: `AND({Folio}="${folio}",{Mes}=${mes})`,
    maxRecords: "1",
  });
  if (cierres.length === 0) return { success: false, message: "Cierre no encontrado" };
  const cierre = cierres[0];

  if (cierre.Estatus === "Pagado") return { success: false, message: "Ya estaba pagado" };

  const cobroFG = cierre["Cobro FG"] || 0;

  // Update cierre
  await atUpdate(TABLE_CIERRES, cierre._id, {
    "Estatus": "Pagado",
    "Fecha Pago": new Date().toISOString().slice(0, 10),
    "Metodo Pago": metodo,
    "Dias Atraso": 0,
  });

  // Update credit: FG += cobroFG, clear atraso
  const creditos = await atFetch(TABLE_CREDITOS, {
    filterByFormula: `{Folio}="${folio}"`,
    maxRecords: "1",
  });
  if (creditos.length > 0) {
    const credito = creditos[0];
    const nuevoFG = Math.min(FG_TECHO, (credito["Saldo FG"] || 0) + cobroFG);
    const nuevoMes = Math.max(credito["Mes Actual"] || 0, mes); // advance Mes Actual on payment
    await atUpdate(TABLE_CREDITOS, credito._id, {
      "Mes Actual": nuevoMes,
      "Saldo FG": nuevoFG,
      "Dias Atraso": 0,
      "Estatus": "Activo",
    });
  }

  // Create Pago record
  await atCreate(TABLE_PAGOS, {
    "Folio": folio,
    "Mes": mes,
    "Concepto": `Diferencial mes ${mes} + FG`,
    "Monto": monto,
    "Método": metodo,
    "Estatus": "Confirmado",
    "Fecha Pago": new Date().toISOString().slice(0, 10),
  });

  return { success: true, message: `Pago registrado: $${monto} (${metodo}). FG actualizado.` };
}

// ===== FORMATTERS =====

export function formatCierreResumenDirector(result: CierreResult): string {
  if (result.creditosProcesados === 0) return "Sin créditos taxi activos para cierre.";
  
  const lines = [
    `*CIERRE MENSUAL CMU*`,
    `Créditos procesados: ${result.creditosProcesados}`,
    ``,
  ];
  
  let totalCuotas = 0, totalRecaudo = 0, totalDif = 0, totalLinks = 0;
  
  for (const d of result.detalle) {
    totalCuotas += d.cuota;
    totalRecaudo += d.recaudo;
    totalDif += d.diferencial;
    totalLinks += d.totalLink;
    lines.push(`*${d.taxista}* (${d.folio}) — mes ${d.mes}`);
    lines.push(`  Cuota: $${d.cuota.toLocaleString()} | GNV: $${d.recaudo.toLocaleString()} | Dif: $${d.diferencial.toLocaleString()}`);
    lines.push(`  Link: $${d.totalLink.toLocaleString()} (dif + FG $${d.cobroFG}) | FG saldo: $${d.saldoFG.toLocaleString()}`);
  }
  
  lines.push(``, `Totales: cuotas $${totalCuotas.toLocaleString()} | GNV $${totalRecaudo.toLocaleString()} | dif $${totalDif.toLocaleString()} | links $${totalLinks.toLocaleString()}`);
  
  return lines.join("\n");
}

export function formatCierreTaxista(d: CierreResult["detalle"][0], linkConekta?: string): string {
  const lines = [
    `*Cierre mes ${d.mes}* — ${d.taxista}`,
    ``,
    `Tu recaudo GNV cubrió $${d.recaudo.toLocaleString()} de tu cuota de $${d.cuota.toLocaleString()}.`,
    `Diferencial: $${d.diferencial.toLocaleString()}`,
  ];
  if (d.cobroFG > 0) {
    lines.push(`Fondo de Garantía: $${d.cobroFG}`);
  }
  lines.push(`*Total: $${d.totalLink.toLocaleString()}*`);
  if (linkConekta) {
    lines.push(``, `Paga aquí: ${linkConekta}`, `Fecha límite: día 5 del mes.`, `Métodos: tarjeta, OXXO, SPEI, tiendas.`);
  }
  return lines.join("\n");
}

export function formatFGResumen(result: FGResult): string {
  if (result.procesados === 0) return "Sin cierres pendientes de FG.";
  
  const lines = [
    `*FG DÍA 6 — APLICACIÓN AUTOMÁTICA*`,
    `Procesados: ${result.procesados} | FG aplicado: ${result.fgAplicados} | Mora: ${result.moraActivada}`,
  ];
  for (const d of result.detalle) {
    lines.push(`- ${d.taxista} (${d.folio}): ${d.accion}`);
  }
  return lines.join("\n");
}

// ===== WEEKLY CARTERA REPORT (COB-07) =====

/**
 * Generate weekly cartera report with semaphore.
 * Called by cron every Wednesday 10:00 AM CST.
 */
export async function generarReporteSemanal(): Promise<string> {
  const TABLE_AHORRO = "tblUjkOQ2rWvBRRmw";
  const TABLE_KIT = "tbletXmlYRwisBcaO";

  // Taxi credits
  const creditos = await atFetch(TABLE_CREDITOS, {
    filterByFormula: `OR({Estatus}="Activo",{Estatus}="Mora Leve")`,
  });
  
  // Joylong
  const joylong = await atFetch(TABLE_AHORRO);
  
  // Kit
  const kits = await atFetch(TABLE_KIT);

  const now = new Date();
  const weekNum = Math.ceil((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / (7 * 24 * 60 * 60 * 1000));
  
  const lines = [`*CARTERA CMU* \u2014 Semana ${weekNum} (${now.toISOString().slice(0, 10)})\n`];

  // Semaphore for taxi credits
  if (creditos.length > 0) {
    lines.push(`*SEMAFORO*`);
    for (const c of creditos) {
      const diasAtraso = c["Dias Atraso"] || 0;
      const saldoFG = c["Saldo FG"] || 0;
      let semaforo = "\ud83d\udfe2"; // green
      if (diasAtraso > 0) semaforo = "\ud83d\udd34"; // red
      else if (saldoFG < 5000) semaforo = "\ud83d\udfe1"; // yellow (FG low)
      lines.push(`  ${semaforo} ${c.Taxista} (${c.Folio}) \u2014 FG $${saldoFG.toLocaleString()}${diasAtraso > 0 ? ` | ${diasAtraso}d atraso` : ""}`);
    }
    
    lines.push(`\n*CREDITOS TAXI* (${creditos.length})`);
    let totalCuotas = 0, totalFG = 0;
    for (const c of creditos) {
      const mes = c["Mes Actual"] || 0;
      const cuota = c["Cuota Actual"] || 0;
      const fg = c["Saldo FG"] || 0;
      totalCuotas += cuota;
      totalFG += fg;
      lines.push(`  ${c.Taxista} | mes ${mes}/36 | cuota $${cuota.toLocaleString()} | FG $${fg.toLocaleString()}`);
    }
    const enMora = creditos.filter(c => (c["Dias Atraso"] || 0) > 0).length;
    lines.push(`  Cuotas: $${totalCuotas.toLocaleString()} | Mora: ${enMora} | Morosidad: ${creditos.length > 0 ? Math.round(enMora / creditos.length * 100) : 0}%`);
  }

  // Joylong
  if (joylong.length > 0) {
    const totalAhorro = joylong.reduce((s: number, j: any) => s + (j["Ahorro Acumulado"] || 0), 0);
    lines.push(`\n*AHORRO JOYLONG* (${joylong.length})`);
    for (const j of joylong) {
      const ahorro = j["Ahorro Acumulado"] || 0;
      const precio = j["Precio Vehiculo"] || 799000;
      const pct = ((ahorro / precio) * 100).toFixed(1);
      lines.push(`  ${j.Cliente} (${j.Folio}): $${ahorro.toLocaleString()} (${pct}%)`);
    }
    lines.push(`  Total: $${totalAhorro.toLocaleString()}`);
  }

  // Kit
  if (kits.length > 0) {
    lines.push(`\n*KIT CONVERSION* (${kits.length})`);
    for (const k of kits) {
      const saldo = k["Saldo Pendiente"] || 0;
      lines.push(`  ${k.Cliente} (${k.Folio}): saldo $${saldo.toLocaleString()} | mes ${k["Mes Actual"] || 1}/${k.Parcialidades || 12}`);
    }
  }

  // Inventory
  // TODO: add inventory summary from Neon

  return lines.join("\n");
}

// ===== CIERRE MENSUAL KIT CONVERSION =====
/**
 * Cierra el mes de cada Kit Conversion activo:
 *  1. Suma recaudo GNV del mes (por folio)
 *  2. Compara contra cuota mensual (\$4,625 para Elvira)
 *  3. Si recaudo >= cuota: acumula excedente al FG (hasta \$375 tope mensual, techo \$4,500)
 *  4. Si recaudo < cuota: aplica FG para cubrir deficit; si FG insuficiente, genera liga
 *  5. Actualiza Saldo Pendiente, Mes Actual, Meses Pagados, Fondo Garantia (espejo)
 *
 * Idempotente: si ya se procesó el mes para un folio, lo saltea.
 */
async function cerrarKitConversionMensual(
  result: CierreResult,
  anio: number,
  mesIdx: number, // 0-indexed
): Promise<void> {
  const TABLE_KIT = "tbletXmlYRwisBcaO";
  const kits = await atFetch(TABLE_KIT, {
    filterByFormula: `{Estatus}="Activo"`,
  });
  if (kits.length === 0) return;

  const { acumularFGMensual, aplicarFG, getSaldoFG } = await import("./fg-engine");

  // Rango del mes en curso (YYYY-MM-01 a YYYY-MM-ultimoDia)
  const mesStart = `${anio}-${String(mesIdx + 1).padStart(2, "0")}-01`;
  const ultimoDia = new Date(anio, mesIdx + 1, 0).getDate();
  const mesEnd = `${anio}-${String(mesIdx + 1).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;
  const mesYYYYMM = `${anio}-${String(mesIdx + 1).padStart(2, "0")}`;

  for (const kit of kits) {
    const folio = kit.Folio;
    const cliente = kit.Cliente || "";
    const telefono = (kit.Telefono || "").replace(/[^0-9]/g, "");
    const cuotaMensual = Number(kit["Cuota Mensual"] || 4625);
    const saldoPendiente = Number(kit["Saldo Pendiente"] || 0);
    const mesActual = Number(kit["Mes Actual"] || 0);
    const mesesPagados = Number(kit["Meses Pagados"] || 0);
    const parcialidades = Number(kit.Parcialidades || 12);
    const proximoMes = mesActual; // "Mes Actual" representa el mes que se esta cerrando ahora

    if (proximoMes > parcialidades) {
      console.log(`[Cierre KIT] ${folio} ya pago todas las parcialidades`);
      continue;
    }

    // 1. Sumar pagos del mes en curso para este folio
    const pagosDelMes = await atFetch("tbl5RiGyVgeE4EVfE", {
      filterByFormula: `AND({Folio}="${folio}",IS_AFTER({Fecha Pago},"${mesStart}"),IS_BEFORE({Fecha Pago},"${mesEnd} 23:59"))`,
    });
    const recaudoMes = pagosDelMes.reduce((acc: number, p: any) => acc + Number(p.Monto || 0), 0);

    console.log(`[Cierre KIT] ${folio} (${cliente}): mes ${proximoMes}, recaudo $${recaudoMes}, cuota $${cuotaMensual}`);

    let accion = "";
    let fgAplicadoMes = 0;
    let fgAcumuladoMes = 0;

    if (recaudoMes >= cuotaMensual) {
      // Cuota cubierta. Acumular excedente al FG.
      const excedente = recaudoMes - cuotaMensual;
      const acum = await acumularFGMensual(folio, mesYYYYMM, `Excedente recaudo ${mesYYYYMM}`, excedente);
      fgAcumuladoMes = acum.acumulado;
      accion = `Cuota cubierta con recaudo (\$${recaudoMes}). Excedente al FG: \$${fgAcumuladoMes}.`;
    } else {
      // Recaudo insuficiente. Aplicar FG.
      const deficit = cuotaMensual - recaudoMes;
      const saldoFGActual = await getSaldoFG(folio);
      if (saldoFGActual >= deficit) {
        const fgOp = await aplicarFG(folio, deficit, `${mesYYYYMM}-mes${proximoMes}`);
        fgAplicadoMes = fgOp.aplicado;
        accion = `Recaudo \$${recaudoMes} + FG \$${fgAplicadoMes} = cuota cubierta.`;
      } else if (saldoFGActual > 0) {
        const fgOp = await aplicarFG(folio, saldoFGActual, `${mesYYYYMM}-mes${proximoMes}`);
        fgAplicadoMes = fgOp.aplicado;
        const restante = deficit - fgAplicadoMes;
        accion = `Recaudo \$${recaudoMes} + FG \$${fgAplicadoMes}. Falta \$${restante} — generar liga.`;
      } else {
        accion = `Recaudo \$${recaudoMes}, sin FG. Falta \$${deficit} — generar liga.`;
      }
    }

    // 2. Actualizar registro Kit
    const nuevoSaldo = Math.max(0, saldoPendiente - cuotaMensual);
    const saldoFGNuevo = await getSaldoFG(folio);
    try {
      await atUpdate(TABLE_KIT, kit._id, {
        "Saldo Pendiente": nuevoSaldo,
        "Mes Actual": proximoMes + 1,
        "Meses Pagados": mesesPagados + 1,
        "Fondo Garantia": saldoFGNuevo,
      });
    } catch (e: any) {
      console.error(`[Cierre KIT] update ${folio}: ${e.message}`);
    }

    result.creditosProcesados++;
    result.detalle.push({
      folio, taxista: cliente, telefono,
      mesCredito: proximoMes,
      cuota: cuotaMensual,
      recaudo: recaudoMes,
      diferencial: Math.max(0, cuotaMensual - recaudoMes),
      fgAplicado: fgAplicadoMes,
      estatus: recaudoMes >= cuotaMensual ? "Cubierto" : (fgAplicadoMes > 0 ? "FG Aplicado" : "Pendiente Pago"),
      accion: accion + (fgAcumuladoMes > 0 ? ` FG acumulado mes: $${fgAcumuladoMes}.` : ""),
    } as any);
  }
}

export function formatMoraResumen(result: MoraCheckResult): string {
  if (result.enMora === 0) return "";
  
  const lines = [`*MORA ACTIVA*`];
  for (const a of result.acciones) {
    if (a.accion) {
      lines.push(`- ${a.taxista} (${a.folio}): ${a.diasAtraso} días | deuda $${a.deuda.toLocaleString()} | ${a.accion}`);
    }
  }
  return lines.join("\n");
}
