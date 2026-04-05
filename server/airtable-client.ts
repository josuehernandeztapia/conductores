/**
 * Airtable Client — CMU Multi-Producto
 * 
 * 3 products, 3 tables + shared Pagos/RecaudoGNV:
 *   1. Taxi Renovación → Creditos (legacy)
 *   2. Joylong Ahorro Individual → Ahorro Joylong
 *   3. Kit Conversión GNV → Kit Conversion
 * 
 * Lookup: phone → search all 3 tables → return unified context
 */

// Airtable config
const AIRTABLE_BASE_ID = "appXxbjjGzXFiX7gk";
const TABLE_CREDITOS = "tblA62WNhSb4xYfYv";
const TABLE_PAGOS = "tbl5RiGyVgeE4EVfE";
const TABLE_AMORTIZACION = "tblWMvUwwdSKyKPSv";
const TABLE_RECAUDO = "tblSUWmIE8Ma5be9u";
const TABLE_AHORRO_JOYLONG = "tblUjkOQ2rWvBRRmw";
const TABLE_KIT_CONVERSION = "tbletXmlYRwisBcaO";

function getAirtableToken(): string | null {
  return process.env.AIRTABLE_PAT || null;
}

async function airtableFetch(tableId: string, params: Record<string, string> = {}): Promise<any[]> {
  const token = getAirtableToken();
  if (!token) {
    console.warn("[Airtable] No PAT configured — cartera queries disabled");
    return [];
  }

  const qs = new URLSearchParams(params).toString();
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}${qs ? "?" + qs : ""}`;

  try {
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[Airtable] Error ${res.status}: ${err}`);
      return [];
    }

    const data = await res.json();
    return (data.records || []).map((r: any) => ({ id: r.id, ...r.fields }));
  } catch (e: any) {
    console.error("[Airtable] Fetch error:", e.message);
    return [];
  }
}

// ===== TYPES =====

export type CreditoRecord = {
  id: string;
  Folio: string;
  Taxista: string;
  Telefono: string;
  Vehiculo: string;
  Placas: string;
  "Precio Contado": number;
  "Saldo Capital": number;
  "Cuota Actual": number;
  "Mes Actual": number;
  "Meses Pagados": number;
  "Saldo FG": number;
  "Dias Atraso": number;
  Estatus: string;
  "Fecha Firma": string;
  Notas: string;
};

export type PagoRecord = {
  id: string;
  Folio: string;
  Mes: number;
  Concepto: string;
  Monto: number;
  "Método": string;
  Estatus: string;
  "Fecha Pago": string;
  Referencia: string;
  Notas: string;
};

export type ClientProduct = {
  producto: "Taxi Renovación" | "Joylong Ahorro" | "Kit Conversión";
  folio: string;
  cliente: string;
  record: any;
};

// ===== PHONE NORMALIZATION =====

function phoneVariants(phone: string): string[] {
  const variants = [phone];
  if (phone.startsWith("+")) variants.push(phone.slice(1));
  if (!phone.startsWith("+")) variants.push("+" + phone);
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("521")) variants.push("+" + digits);
  if (digits.length === 12 && digits.startsWith("52")) variants.push("+52" + digits.slice(2));
  if (digits.length === 10) variants.push("+521" + digits, "+52" + digits);
  // Also try +52 4XX format (without 1)
  if (digits.length === 13 && digits.startsWith("521")) {
    variants.push("+52" + digits.slice(3));
  }
  return [...new Set(variants)];
}

async function findInTableByPhone(tableId: string, phoneField: string, phone: string): Promise<any | null> {
  for (const v of phoneVariants(phone)) {
    const records = await airtableFetch(tableId, {
      filterByFormula: `{${phoneField}}="${v}"`,
      maxRecords: "5",
    });
    if (records.length > 0) return records;
  }
  return null;
}

// ===== MULTI-PRODUCT LOOKUP =====

/**
 * Find ALL products for a phone number across all 3 tables.
 * A client can have multiple products (e.g., Elvira could have both Joylong + Kit).
 */
export async function findProductsByPhone(phone: string): Promise<ClientProduct[]> {
  const products: ClientProduct[] = [];

  // 1. Taxi Renovación (Creditos)
  const taxiRecords = await findInTableByPhone(TABLE_CREDITOS, "Telefono", phone);
  if (taxiRecords) {
    for (const r of taxiRecords) {
      products.push({ producto: "Taxi Renovación", folio: r.Folio, cliente: r.Taxista, record: r });
    }
  }

  // 2. Joylong Ahorro Individual
  const joylongRecords = await findInTableByPhone(TABLE_AHORRO_JOYLONG, "Telefono", phone);
  if (joylongRecords) {
    for (const r of joylongRecords) {
      products.push({ producto: "Joylong Ahorro", folio: r.Folio, cliente: r.Cliente, record: r });
    }
  }

  // 3. Kit Conversión
  const kitRecords = await findInTableByPhone(TABLE_KIT_CONVERSION, "Telefono", phone);
  if (kitRecords) {
    for (const r of kitRecords) {
      products.push({ producto: "Kit Conversión", folio: r.Folio, cliente: r.Cliente, record: r });
    }
  }

  return products;
}

// ===== LEGACY FUNCTIONS (backward compat) =====

export async function findCreditByPhone(phone: string): Promise<CreditoRecord | null> {
  const records = await findInTableByPhone(TABLE_CREDITOS, "Telefono", phone);
  return records ? records[0] as CreditoRecord : null;
}

export async function findCreditByFolio(folio: string): Promise<CreditoRecord | null> {
  const records = await airtableFetch(TABLE_CREDITOS, {
    filterByFormula: `{Folio}="${folio}"`,
    maxRecords: "1",
  });
  return records.length > 0 ? records[0] as CreditoRecord : null;
}

export async function getAllCredits(): Promise<CreditoRecord[]> {
  return await airtableFetch(TABLE_CREDITOS) as CreditoRecord[];
}

export async function getCreditsInMora(): Promise<CreditoRecord[]> {
  return await airtableFetch(TABLE_CREDITOS, { filterByFormula: `{Dias Atraso}>0` }) as CreditoRecord[];
}

export async function getPaymentsByFolio(folio: string): Promise<PagoRecord[]> {
  return await airtableFetch(TABLE_PAGOS, {
    filterByFormula: `{Folio}="${folio}"`,
    "sort[0][field]": "Fecha Pago",
    "sort[0][direction]": "desc",
  }) as PagoRecord[];
}

export async function getPendingPayments(): Promise<PagoRecord[]> {
  return await airtableFetch(TABLE_PAGOS, { filterByFormula: `{Estatus}="Pendiente"` }) as PagoRecord[];
}

export async function getRecaudoByFolio(folio: string, lastN = 3): Promise<any[]> {
  return await airtableFetch(TABLE_RECAUDO, {
    filterByFormula: `{Folio}="${folio}"`,
    "sort[0][field]": "Mes",
    "sort[0][direction]": "desc",
    maxRecords: String(lastN),
  });
}

// ===== CONTEXT BUILDERS =====

/**
 * Build context for Joylong Ahorro client
 */
function buildJoylongContext(record: any): string {
  const ahorro = record["Ahorro Acumulado"] || 0;
  const precio = record["Precio Vehiculo"] || 799000;
  const gatillo = record.Gatillo || 399500;
  const faltaGatillo = Math.max(0, gatillo - ahorro);
  const pct = ((ahorro / precio) * 100).toFixed(1);
  const fg = record["Fondo Garantia"] || 0;

  const lines = [
    `=== AHORRO JOYLONG (Promesa de Compraventa) ===`,
    `Folio: ${record.Folio}`,
    `Producto: Joylong M6 HKL6600AM (19 pasajeros)`,
    `Precio: $${precio.toLocaleString()}`,
    `Ahorro acumulado: $${ahorro.toLocaleString()} (${pct}% del precio)`,
    `Gatillo de pedido (50%): $${gatillo.toLocaleString()}`,
    `Falta para gatillo: $${faltaGatillo.toLocaleString()}`,
    `Fondo de Garantia: $${fg.toLocaleString()}`,
    `Estatus: ${record.Estatus}`,
  ];

  if (record.Estatus === "Gatillo Alcanzado") {
    lines.push(`*** El ahorro alcanzo el 50% — la importacion del vehiculo ya se puede activar. ***`);
  }

  return lines.join("\n");
}

/**
 * Build context for Kit Conversión client
 */
function buildKitConversionContext(record: any): string {
  const precio = record["Precio Kit"] || 55500;
  const saldo = record["Saldo Pendiente"] || 0;
  const cuota = record["Cuota Mensual"] || 4625;
  const parcialidades = record.Parcialidades || 12;
  const mesActual = record["Mes Actual"] || 1;
  const mesesPagados = record["Meses Pagados"] || 0;
  const fg = record["Fondo Garantia"] || 0;
  const pagado = precio - saldo;
  const pctPagado = ((pagado / precio) * 100).toFixed(1);

  const lines = [
    `=== KIT CONVERSION GNV (Compraventa a Plazos) ===`,
    `Folio: ${record.Folio}`,
    `Vehiculo: ${record.Vehiculo || "N/A"}`,
    `Equipo: Kit Blumec 5a generacion, 2x100L`,
    `Precio total: $${precio.toLocaleString()} en ${parcialidades} parcialidades de $${cuota.toLocaleString()}`,
    `Pagado: $${pagado.toLocaleString()} (${pctPagado}%)`,
    `Saldo pendiente: $${saldo.toLocaleString()}`,
    `Mes actual: ${mesActual} de ${parcialidades}`,
    `Meses con cuota cubierta: ${mesesPagados}`,
    `Fondo de Garantia: $${fg.toLocaleString()} (max $4,500)`,
    `Estatus: ${record.Estatus}`,
  ];

  return lines.join("\n");
}

/**
 * Build context for Taxi Renovación client (legacy)
 */
async function buildTaxiContext(record: any): Promise<string> {
  const folio = record.Folio;
  const pagos = await getPaymentsByFolio(folio);
  const recaudo = await getRecaudoByFolio(folio, 3);

  const lines: string[] = [];
  lines.push(`=== CREDITO TAXI (Renovacion Vehicular) ===`);
  lines.push(`Folio: ${record.Folio}`);
  lines.push(`Vehiculo: ${record.Vehiculo} | Placas: ${record.Placas}`);
  lines.push(`Mes: ${record["Mes Actual"]} de 36 | Meses pagados: ${record["Meses Pagados"]}`);
  lines.push(`Saldo capital: $${(record["Saldo Capital"] || 0).toLocaleString()}`);
  lines.push(`Cuota actual: $${(record["Cuota Actual"] || 0).toLocaleString()}/mes`);
  lines.push(`Fondo de Garantia: $${(record["Saldo FG"] || 0).toLocaleString()} de $20,000`);
  lines.push(`Estatus: ${record.Estatus}`);
  if (record["Dias Atraso"] > 0) lines.push(`MORA: ${record["Dias Atraso"]} dias de atraso`);

  if (pagos.length > 0) {
    lines.push(`\nULTIMOS PAGOS:`);
    for (const p of pagos.slice(0, 5)) {
      lines.push(`- ${p.Concepto}: $${(p.Monto || 0).toLocaleString()} (${p.Estatus}) ${p["Fecha Pago"] || ""} via ${p["Método"] || "?"}`);
    }
  }

  if (recaudo.length > 0) {
    lines.push(`\nRECAUDO GNV (ultimos meses):`);
    for (const r of recaudo) {
      lines.push(`- ${r.Periodo || "Mes " + r.Mes}: ${r.LEQ || 0} LEQ = $${(r.Recaudo || 0).toLocaleString()}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build complete client context for WhatsApp agent.
 * Searches ALL product tables by phone number.
 * Returns null if phone not found in any table.
 */
export async function buildClientCarteraContext(phone: string): Promise<string | null> {
  const products = await findProductsByPhone(phone);
  if (products.length === 0) return null;

  const sections: string[] = [];

  for (const p of products) {
    if (p.producto === "Joylong Ahorro") {
      sections.push(buildJoylongContext(p.record));
    } else if (p.producto === "Kit Conversión") {
      sections.push(buildKitConversionContext(p.record));
    } else if (p.producto === "Taxi Renovación") {
      sections.push(await buildTaxiContext(p.record));
    }
  }

  return sections.join("\n\n");
}

/**
 * Build director-level dashboard across ALL products
 */
export async function buildCarteraDashboard(): Promise<string> {
  const lines: string[] = [];

  // Taxi credits
  const creditos = await getAllCredits();
  const activosTaxi = creditos.filter(c => c.Estatus === "Activo" || c.Estatus === "Mora Leve");

  // Joylong
  const joylong = await airtableFetch(TABLE_AHORRO_JOYLONG);

  // Kit
  const kits = await airtableFetch(TABLE_KIT_CONVERSION);

  lines.push(`CARTERA CMU — ${activosTaxi.length + joylong.length + kits.length} contratos activos`);

  // Joylong section
  if (joylong.length > 0) {
    const totalAhorro = joylong.reduce((s: number, r: any) => s + (r["Ahorro Acumulado"] || 0), 0);
    lines.push(`\nJOYLONG AHORRO (${joylong.length} contratos):`);
    lines.push(`Total ahorrado: $${totalAhorro.toLocaleString()}`);
    for (const j of joylong) {
      const ahorro = j["Ahorro Acumulado"] || 0;
      const precio = j["Precio Vehiculo"] || 799000;
      const pct = ((ahorro / precio) * 100).toFixed(1);
      lines.push(`- ${j.Cliente} (${j.Folio}): $${ahorro.toLocaleString()} (${pct}%) — ${j.Estatus}`);
    }
  }

  // Kit section
  if (kits.length > 0) {
    lines.push(`\nKIT CONVERSION (${kits.length} contratos):`);
    for (const k of kits) {
      const saldo = k["Saldo Pendiente"] || 0;
      const precio = k["Precio Kit"] || 55500;
      const pagado = precio - saldo;
      lines.push(`- ${k.Cliente} (${k.Folio}): pagado $${pagado.toLocaleString()} de $${precio.toLocaleString()} — ${k.Estatus}`);
    }
  }

  // Taxi section
  if (activosTaxi.length > 0) {
    const totalCartera = activosTaxi.reduce((s, c) => s + (c["Saldo Capital"] || 0), 0);
    const enMora = activosTaxi.filter(c => (c["Dias Atraso"] || 0) > 0);
    lines.push(`\nTAXI RENOVACION (${activosTaxi.length} creditos):`);
    lines.push(`Saldo cartera: $${totalCartera.toLocaleString()}`);
    if (enMora.length > 0) {
      lines.push(`En mora: ${enMora.length}`);
      for (const c of enMora) {
        lines.push(`- ${c.Taxista}: ${c["Dias Atraso"]} dias atraso`);
      }
    }
  } else {
    lines.push(`\nTAXI RENOVACION: Sin creditos activos (3 registros de prueba en base)`);
  }

  return lines.join("\n");
}

// ===== ESTADO DE CUENTA (COB-06) =====

/**
 * Build detailed estado de cuenta for a taxi credit client.
 * Shows weekly recaudo breakdown, estimated diferencial, FG, and history.
 */
export async function buildEstadoCuenta(phone: string): Promise<string | null> {
  const TABLE_CIERRES = "tblVFP0kXEmvD6EZS";
  const TABLE_RECAUDO_GNV = "tblSUWmIE8Ma5be9u";
  
  // Find credit by phone
  const credito = await findCreditByPhone(phone);
  if (!credito) return null;
  
  const folio = credito.Folio;
  const mesActual = credito["Mes Actual"] || 1;
  const saldoCapital = credito["Saldo Capital"] || 0;
  const cuotaActual = credito["Cuota Actual"] || 0;
  const saldoFG = credito["Saldo FG"] || 0;
  const diasAtraso = credito["Dias Atraso"] || 0;
  const taxista = credito.Taxista || "Cliente";
  
  // Get recaudo for current month
  const recaudoRows = await airtableFetch(TABLE_RECAUDO_GNV, {
    filterByFormula: `AND({Folio}="${folio}",{Mes}=${mesActual})`,
  });
  const recaudoAcum = recaudoRows.reduce((s: number, r: any) => s + (r.Recaudo || 0), 0);
  const semanasProc = recaudoRows.length;
  const estimadoMes = semanasProc > 0 ? Math.round((recaudoAcum / semanasProc) * 4) : 0;
  const difEstimado = Math.max(0, cuotaActual - estimadoMes);
  
  // Get last 3 cierres
  const cierres = await airtableFetch(TABLE_CIERRES, {
    filterByFormula: `{Folio}="${folio}"`,
    "sort[0][field]": "Mes",
    "sort[0][direction]": "desc",
    maxRecords: "3",
  });
  
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const proximoCorte = `${nextMonth.getDate()} de ${["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"][nextMonth.getMonth()]}`.replace(/^1 de/, "1 de");
  
  const lines = [
    `*Estado de cuenta* — ${taxista}`,
    `Folio ${folio} | Mes ${mesActual} de 36`,
    `Proximo corte: 1 de ${["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"][nextMonth.getMonth()]}`,
    ``,
    `*RECAUDO DEL MES* (${semanasProc} de ~4 semanas)`,
  ];
  
  for (const r of recaudoRows) {
    lines.push(`  Semana: $${(r.Recaudo || 0).toLocaleString()} (${r.LEQ || 0} LEQ)`);
  }
  lines.push(`  Acumulado: $${recaudoAcum.toLocaleString()} | Estimado mes: ~$${estimadoMes.toLocaleString()}`);
  
  lines.push(
    ``,
    `*CUOTA Y DIFERENCIAL*`,
    `  Cuota mes ${mesActual}: $${cuotaActual.toLocaleString()}`,
    `  Diferencial estimado: ~$${difEstimado.toLocaleString()}`,
    `  + FG $334`,
    `  Link estimado: ~$${(difEstimado + 334).toLocaleString()}`,
    ``,
    `*SALDOS*`,
    `  Capital pendiente: $${saldoCapital.toLocaleString()}`,
    `  Fondo de Garantia: $${saldoFG.toLocaleString()} de $20,000`,
    `  Dias atraso: ${diasAtraso}`,
  );
  
  if (cierres.length > 0) {
    lines.push(``, `*ULTIMOS MESES*`);
    for (const c of cierres) {
      const est = c.Estatus === "Pagado" ? "Pagado ✅" : c.Estatus === "FG Aplicado" ? "FG ✅" : c.Estatus;
      lines.push(`  Mes ${c.Mes}: cuota $${(c.Cuota || 0).toLocaleString()} | GNV $${(c["Recaudo GNV"] || 0).toLocaleString()} | dif $${(c.Diferencial || 0).toLocaleString()} → ${est}`);
    }
  }
  
  lines.push(``, `Necesitas tu liga de pago o tienes alguna duda?`);
  
  return lines.join("\n");
}

/**
 * Check if Airtable is configured
 */
export function isAirtableEnabled(): boolean {
  return !!getAirtableToken();
}
