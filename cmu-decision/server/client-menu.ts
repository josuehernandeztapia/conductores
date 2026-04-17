/**
 * CLIENT MENU — Handler for taxistas with active credits
 * 
 * Detects client by phone number across 3 Airtable tables:
 * 1. Creditos (Taxi Renovación) — monthly cuota
 * 2. Ahorro Joylong — savings towards vehicle
 * 3. Kit Conversión — kit payment
 * 
 * Provides: greeting with credit summary, estado de cuenta,
 * payment link, recaudo status, promotor escalation.
 */

const AIRTABLE_BASE = "appXxbjjGzXFiX7gk";
const TABLE_CREDITOS = "tblA62WNhSb4xYfYv";
const TABLE_AHORRO = "tblUjkOQ2rWvBRRmw";
const TABLE_KIT = "tbletXmlYRwisBcaO";
const TABLE_PAGOS = "tbl5RiGyVgeE4EVfE";
const TABLE_PLACAS = "tblb4cdo0wv3qeWxs";

async function atFetch(table: string, params?: Record<string, string>): Promise<any[]> {
  const pat = process.env.AIRTABLE_PAT || "";
  if (!pat) return [];
  const qs = params ? "?" + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&") : "";
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}${qs}`, {
    headers: { Authorization: `Bearer ${pat}` },
    signal: AbortSignal.timeout(10000),
  });
  const data: any = await res.json();
  return (data.records || []).map((r: any) => ({ _id: r.id, ...r.fields }));
}

// ===== TYPES =====

interface ClientCredit {
  type: "taxi" | "joylong" | "kit";
  folio: string;
  nombre: string;
  vehiculo?: string;
  // Taxi
  saldoCapital?: number;
  cuotaActual?: number;
  mesActual?: number;
  mesesPagados?: number;
  saldoFG?: number;
  diasAtraso?: number;
  estatus?: string;
  precioContado?: number;
  // Joylong
  ahorroAcumulado?: number;
  precioVehiculo?: number;
  pctAvance?: number;
  gatillo?: number;
  // Kit
  saldoPendiente?: number;
  precioKit?: number;
}

// ===== LOOKUP =====

export async function findClientByPhone(phone: string): Promise<ClientCredit | null> {
  // Normalize phone: try with/without country code
  const variants = [phone, `+${phone}`, `+52${phone}`, phone.replace(/^52/, ""), phone.replace(/^521/, "")];
  const phoneFilter = variants.map(p => `{Telefono}="${p}"`).join(",");

  // 1. Check Creditos (Taxi Renovación)
  try {
    const creditos = await atFetch(TABLE_CREDITOS, {
      filterByFormula: `AND(OR(${phoneFilter}),{Estatus}="Activo")`,
      maxRecords: "1",
    });
    if (creditos.length > 0) {
      const c = creditos[0];
      return {
        type: "taxi",
        folio: c.Folio || "?",
        nombre: c.Taxista || "?",
        vehiculo: c.Vehiculo,
        saldoCapital: c["Saldo Capital"],
        cuotaActual: c["Cuota Actual"],
        mesActual: c["Mes Actual"],
        mesesPagados: c["Meses Pagados"],
        saldoFG: c["Saldo FG"],
        diasAtraso: c["Dias Atraso"],
        estatus: c.Estatus,
        precioContado: c["Precio Contado"],
      };
    }
  } catch (e: any) { console.error("[Client] Creditos lookup:", e.message); }

  // 2. Check Ahorro Joylong
  try {
    const ahorro = await atFetch(TABLE_AHORRO, {
      filterByFormula: `AND(OR(${phoneFilter}),{Estatus}!="Cancelado")`,
      maxRecords: "1",
    });
    if (ahorro.length > 0) {
      const a = ahorro[0];
      return {
        type: "joylong",
        folio: a.Folio || "?",
        nombre: a.Cliente || "?",
        ahorroAcumulado: a["Ahorro Acumulado"],
        precioVehiculo: a["Precio Vehiculo"],
        pctAvance: a["Pct Avance"],
        gatillo: a.Gatillo,
        estatus: a.Estatus,
      };
    }
  } catch (e: any) { console.error("[Client] Joylong lookup:", e.message); }

  // 3. Check Kit Conversión
  try {
    const kits = await atFetch(TABLE_KIT, {
      filterByFormula: `AND(OR(${phoneFilter}),{Estatus}!="Cancelado")`,
      maxRecords: "1",
    });
    if (kits.length > 0) {
      const k = kits[0];
      return {
        type: "kit",
        folio: k.Folio || "?",
        nombre: k.Cliente || "?",
        saldoPendiente: k["Saldo Pendiente"],
        precioKit: k["Precio Kit"],
        mesActual: k["Mes Actual"],
        estatus: k.Estatus,
      };
    }
  } catch (e: any) { console.error("[Client] Kit lookup:", e.message); }

  return null;
}

// ===== GREETING =====

export function clientGreeting(credit: ClientCredit, timeGreet: string): string {
  const firstName = credit.nombre.split(" ")[0];
  const lines: string[] = [`${timeGreet} ${firstName} \ud83d\udc4b`];

  if (credit.type === "taxi") {
    lines.push(``);
    lines.push(`\ud83d\ude95 *Tu cr\u00e9dito ${credit.folio}:*`);
    lines.push(`Veh\u00edculo: ${credit.vehiculo || "?"}`);
    lines.push(`Mes ${credit.mesActual || 1}/36 | Cuota: $${(credit.cuotaActual || 0).toLocaleString()}`);
    lines.push(`Saldo: $${(credit.saldoCapital || 0).toLocaleString()} | FG: $${(credit.saldoFG || 0).toLocaleString()}`);
    if ((credit.diasAtraso || 0) > 0) {
      lines.push(`\u26a0\ufe0f D\u00edas de atraso: ${credit.diasAtraso}`);
    }
  } else if (credit.type === "joylong") {
    const pct = ((credit.pctAvance || 0) * 100).toFixed(1);
    lines.push(``);
    lines.push(`\ud83d\ude8c *Tu ahorro Joylong ${credit.folio}:*`);
    lines.push(`Ahorro: $${(credit.ahorroAcumulado || 0).toLocaleString()} de $${(credit.precioVehiculo || 799000).toLocaleString()}`);
    lines.push(`Avance: ${pct}% | Gatillo: $${(credit.gatillo || 399500).toLocaleString()}`);
  } else if (credit.type === "kit") {
    lines.push(``);
    lines.push(`\ud83d\udd27 *Tu kit GNV ${credit.folio}:*`);
    lines.push(`Saldo pendiente: $${(credit.saldoPendiente || 0).toLocaleString()}`);
    lines.push(`Precio kit: $${(credit.precioKit || 55500).toLocaleString()}`);
  }

  lines.push(``);
  lines.push(`\u00bfQu\u00e9 necesitas?`);
  lines.push(`1\ufe0f\u20e3 Estado de cuenta`);
  lines.push(`2\ufe0f\u20e3 Hacer un pago`);
  lines.push(`3\ufe0f\u20e3 Mi recaudo GNV`);
  lines.push(`4\ufe0f\u20e3 Hablar con promotor`);

  return lines.join("\n");
}

// ===== OPTION HANDLERS =====

export async function clientEstadoCuenta(credit: ClientCredit): Promise<string> {
  // Fetch recent payments
  const pagos = await atFetch(TABLE_PAGOS, {
    filterByFormula: `AND({Folio}="${credit.folio}",{Estatus}="Confirmado")`,
  });
  const totalPagado = pagos.reduce((s: number, p: any) => s + (p.Monto || 0), 0);
  const numPagos = pagos.length;

  const lines: string[] = [`\ud83d\udcca *Estado de Cuenta*`, `Folio: ${credit.folio}`, ``];

  if (credit.type === "taxi") {
    lines.push(`Veh\u00edculo: ${credit.vehiculo || "?"}`);
    lines.push(`Precio contado: $${(credit.precioContado || 0).toLocaleString()}`);
    lines.push(`Mes actual: ${credit.mesActual || 1}/36`);
    lines.push(`Cuota este mes: $${(credit.cuotaActual || 0).toLocaleString()}`);
    lines.push(`Saldo capital: $${(credit.saldoCapital || 0).toLocaleString()}`);
    lines.push(`Fondo de Garant\u00eda: $${(credit.saldoFG || 0).toLocaleString()}`);
    lines.push(`D\u00edas de atraso: ${credit.diasAtraso || 0}`);
    lines.push(``);
    lines.push(`\ud83d\udcb0 Pagos registrados: ${numPagos}`);
    lines.push(`Total pagado: $${totalPagado.toLocaleString()}`);
  } else if (credit.type === "joylong") {
    const pct = ((credit.pctAvance || 0) * 100).toFixed(1);
    lines.push(`Ahorro acumulado: $${(credit.ahorroAcumulado || 0).toLocaleString()}`);
    lines.push(`Precio veh\u00edculo: $${(credit.precioVehiculo || 799000).toLocaleString()}`);
    lines.push(`Avance: ${pct}%`);
    lines.push(`Gatillo (50%): $${(credit.gatillo || 399500).toLocaleString()}`);
    lines.push(`Falta para gatillo: $${Math.max(0, (credit.gatillo || 399500) - (credit.ahorroAcumulado || 0)).toLocaleString()}`);
    lines.push(``);
    lines.push(`\ud83d\udcb0 Recaudos registrados: ${numPagos}`);
    lines.push(`Total recaudo: $${totalPagado.toLocaleString()}`);
  } else if (credit.type === "kit") {
    lines.push(`Precio kit: $${(credit.precioKit || 55500).toLocaleString()}`);
    lines.push(`Saldo pendiente: $${(credit.saldoPendiente || 0).toLocaleString()}`);
    lines.push(`Pagado: $${totalPagado.toLocaleString()}`);
    lines.push(``);
    lines.push(`\ud83d\udcb0 Pagos registrados: ${numPagos}`);
  }

  // Last 3 payments
  if (pagos.length > 0) {
    const recent = pagos.sort((a: any, b: any) => (b["Fecha Pago"] || "").localeCompare(a["Fecha Pago"] || "")).slice(0, 3);
    lines.push(``);
    lines.push(`\u00daltimos pagos:`);
    for (const p of recent) {
      lines.push(`\u2022 ${p["Fecha Pago"] || "?"}: $${(p.Monto || 0).toLocaleString()} \u2014 ${p.Concepto || "?"}`);
    }
  }

  return lines.join("\n");
}

export function clientHacerPago(credit: ClientCredit): string {
  const lines: string[] = [`\ud83d\udcb3 *Hacer un pago*`, ``];

  if (credit.type === "taxi") {
    lines.push(`Cuota este mes: *$${(credit.cuotaActual || 0).toLocaleString()}*`);
    lines.push(`Folio de referencia: *${credit.folio}*`);
  } else if (credit.type === "joylong") {
    lines.push(`Tu ahorro crece con cada carga de GNV en estaciones con convenio CMU.`);
    lines.push(`No necesitas hacer pagos manuales \u2014 el recaudo es autom\u00e1tico.`);
    return lines.join("\n");
  } else if (credit.type === "kit") {
    lines.push(`Saldo pendiente: *$${(credit.saldoPendiente || 0).toLocaleString()}*`);
    lines.push(`Tu recaudo GNV abona autom\u00e1ticamente.`);
  }

  lines.push(``);
  lines.push(`*Opciones de pago:*`);
  lines.push(`1. Liga de pago (SPEI, OXXO, 7-Eleven) \u2014 escribe *liga*`);
  lines.push(`2. Transferencia directa:`);
  lines.push(`   CLABE: *152680120000787681*`);
  lines.push(`   Banco: Bancrea`);
  lines.push(`   Referencia: *${credit.folio}*`);
  lines.push(``);
  lines.push(`Despu\u00e9s de pagar, m\u00e1ndame tu comprobante por aqu\u00ed para confirmar.`);

  return lines.join("\n");
}

export async function clientRecaudoGNV(credit: ClientCredit): Promise<string> {
  // Find placas for this folio
  const placas = await atFetch(TABLE_PLACAS, {
    filterByFormula: `{Folio}="${credit.folio}"`,
  });

  const lines: string[] = [`\u26fd *Mi recaudo GNV*`, ``];

  if (placas.length === 0) {
    lines.push(`No tienes placas registradas en el sistema de recaudo.`);
    lines.push(`Contacta a tu promotor para verificar.`);
    return lines.join("\n");
  }

  lines.push(`Placas registradas: ${placas.map((p: any) => p.Placa).join(", ")}`);

  // Get recent pagos for recaudo
  const pagos = await atFetch(TABLE_PAGOS, {
    filterByFormula: `AND({Folio}="${credit.folio}",{Concepto}="Recaudo GNV",{Estatus}="Confirmado")`,
  });

  if (pagos.length === 0) {
    lines.push(``);
    lines.push(`A\u00fan no hay recaudos registrados.`);
    lines.push(`Carga GNV en estaciones con convenio CMU y se registra autom\u00e1ticamente.`);
  } else {
    const totalRecaudo = pagos.reduce((s: number, p: any) => s + (p.Monto || 0), 0);
    const recent = pagos.sort((a: any, b: any) => (b["Fecha Pago"] || "").localeCompare(a["Fecha Pago"] || "")).slice(0, 3);

    lines.push(`Total recaudo acumulado: *$${totalRecaudo.toLocaleString()}*`);
    lines.push(``);
    lines.push(`\u00daltimos recaudos:`);
    for (const p of recent) {
      lines.push(`\u2022 ${p["Fecha Pago"] || "?"}: $${(p.Monto || 0).toLocaleString()} \u2014 ${p.Notas || ""}`);
    }
  }

  if (credit.type === "joylong") {
    const pct = ((credit.pctAvance || 0) * 100).toFixed(1);
    lines.push(``);
    lines.push(`\ud83d\udcca Avance hacia tu veh\u00edculo: *${pct}%*`);
    lines.push(`Ahorro: $${(credit.ahorroAcumulado || 0).toLocaleString()} de $${(credit.precioVehiculo || 799000).toLocaleString()}`);
  }

  return lines.join("\n");
}
