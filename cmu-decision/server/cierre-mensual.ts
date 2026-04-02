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

const AIRTABLE_PAT = () => process.env.AIRTABLE_PAT || "";
const AIRTABLE_BASE = "appXxbjjGzXFiX7gk";

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

  // 1. Get all active taxi credits
  const creditos = await atFetch(TABLE_CREDITOS, {
    filterByFormula: `OR({Estatus}="Activo",{Estatus}="Mora Leve")`,
  });

  if (creditos.length === 0) {
    console.log("[Cierre] No active taxi credits found");
    return { creditosProcesados: 0, detalle: [] };
  }

  const result: CierreResult = { creditosProcesados: 0, detalle: [] };

  for (const credito of creditos) {
    const folio = credito.Folio;
    const mesCredito = (credito["Mes Actual"] || 0) + 1; // advance to next month
    const telefono = credito.Telefono || "";
    const taxista = credito.Taxista || "?";
    const saldoFG = credito["Saldo FG"] || 0;
    const fechaFirma = credito["Fecha Firma"] || "";
    const precioPlazos = credito["Precio Plazos"] || credito["Precio Contado"] || 0;
    const plazo = 36;
    const tasaAnual = credito["Tasa Anual"] || 0.24; // 24% default

    // Check if cierre already exists for this folio+mes
    const existingCierre = await atFetch(TABLE_CIERRES, {
      filterByFormula: `AND({Folio}="${folio}",{Mes}=${mesCredito})`,
      maxRecords: "1",
    });
    if (existingCierre.length > 0) {
      console.log(`[Cierre] ${folio} mes ${mesCredito} already closed — skipping`);
      continue;
    }

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

    // 7. Create Cierre record
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
      "Dias Atraso": 0,
      "Notas": `Cierre automático. Recaudo de ${recaudoRows.length} registros.`,
    });

    // 8. Update credit: advance Mes Actual
    await atUpdate(TABLE_CREDITOS, credito._id, {
      "Mes Actual": mesCredito,
    });

    result.creditosProcesados++;
    result.detalle.push({
      folio, taxista, telefono, mes: mesCredito,
      cuota, recaudo, diferencial, cobroFG, totalLink,
      saldoFG,
    });

    console.log(`[Cierre] ${folio} mes ${mesCredito}: cuota $${cuota}, recaudo $${recaudo}, dif $${diferencial}, link $${totalLink}`);
  }

  return result;
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

  for (const cierre of pendientes) {
    const folio = cierre.Folio;
    const diferencial = cierre.Diferencial || 0;

    // Get credit for FG balance
    const creditos = await atFetch(TABLE_CREDITOS, {
      filterByFormula: `{Folio}="${folio}"`,
      maxRecords: "1",
    });
    if (creditos.length === 0) continue;
    const credito = creditos[0];
    const saldoFG = credito["Saldo FG"] || 0;
    const telefono = credito.Telefono || "";
    const taxista = credito.Taxista || "?";

    if (saldoFG >= diferencial) {
      // FG covers everything
      const nuevoFG = saldoFG - diferencial;
      await atUpdate(TABLE_CIERRES, cierre._id, {
        "Estatus": "FG Aplicado",
        "FG Aplicado": diferencial,
        "Metodo Pago": "FG",
        "Fecha Pago": new Date().toISOString().slice(0, 10),
      });
      await atUpdate(TABLE_CREDITOS, credito._id, {
        "Saldo FG": nuevoFG,
        "Dias Atraso": 0,
      });
      result.fgAplicados++;
      result.detalle.push({ folio, taxista, telefono, diferencial, fgDisponible: saldoFG, fgAplicado: diferencial, deudaRestante: 0, accion: `FG cubrió $${diferencial}. Saldo FG: $${nuevoFG}` });
    } else {
      // FG partial or zero — MORA
      const fgAplicado = saldoFG; // use whatever is left
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

    // Determine action based on days
    let accion = "";
    if (diasAtraso === 3) {
      accion = `Recargo aplicado: $${MORA_FEE} + 2% = $${recargos}. Generar liga 3: $${deudaTotal}`;
    } else if (diasAtraso === 5) {
      accion = "Último aviso antes de notificar a dirección";
    } else if (diasAtraso === 10) {
      accion = "ESCALAR A JOSUÉ — 15 días de mora";
    } else if (diasAtraso >= 25) {
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
    await atUpdate(TABLE_CREDITOS, credito._id, {
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
