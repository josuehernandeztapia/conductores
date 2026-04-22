/**
 * Contract Engine v10 — DOCX Template Mail Merge
 * 
 * Fills DOCX templates with data from Neon DB + Airtable, converts to PDF.
 * Templates are in server/templates/ (9 DOCX files).
 * 
 * Uses docx-templates for mail merge and LibreOffice for PDF conversion.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import createReport from "docx-templates";

// Template directory — use process.cwd() which works in both ESM and CJS
const TEMPLATES_DIR = join(process.cwd(), "server", "templates");
const TEMPLATES_DIR_ALT = join(process.cwd(), "templates");

function getTemplatePath(name: string): string {
  const primary = join(TEMPLATES_DIR, name);
  if (existsSync(primary)) return primary;
  const alt = join(TEMPLATES_DIR_ALT, name);
  if (existsSync(alt)) return alt;
  throw new Error(`Template not found: ${name} (checked ${primary} and ${alt})`);
}

// ===== HELPERS =====

function fmtMoney(n: number | null | undefined): string {
  if (!n) return "$0";
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function fmtDate(iso?: string | Date | null): string {
  if (!iso) return "____________";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const months = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  return `${d.getDate()} de ${months[d.getMonth()]} de ${d.getFullYear()}`;
}

function fmtDateShort(iso?: string | Date | null): string {
  if (!iso) return "__/__/____";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
}

function safe(val: any, fallback = "____________"): string {
  if (val === null || val === undefined || val === "") return fallback;
  return String(val);
}

function safeJson(json: string | null, key: string, fallback = "____________"): string {
  if (!json) return fallback;
  try { return JSON.parse(json)[key] || fallback; } catch { return fallback; }
}

function fullName(taxista: any): string {
  if (!taxista) return "____________";
  return [taxista.nombre, taxista.apellidoPaterno || taxista.apellido_paterno, taxista.apellidoMaterno || taxista.apellido_materno].filter(Boolean).join(" ") || "____________";
}

// ===== CORE ENGINE =====

async function fillTemplate(templateName: string, data: Record<string, any>): Promise<Buffer> {
  const templatePath = getTemplatePath(templateName);
  const template = readFileSync(templatePath);
  
  try {
    const result = await createReport({
      template,
      data,
      cmdDelimiter: ["{{", "}}"],
      failFast: false,
    });
    return Buffer.from(result);
  } catch (e: any) {
    console.error(`[ContractEngine] Template fill error (${templateName}):`, e.message);
    // Return original template if fill fails
    return Buffer.from(template);
  }
}

/** Convert DOCX buffer to PDF using LibreOffice */
export async function docxToPdf(docxBuffer: Buffer): Promise<Buffer> {
  const tmpDir = "/tmp";
  const tmpFile = join(tmpDir, `cmu-contract-${Date.now()}.docx`);
  const pdfFile = tmpFile.replace(".docx", ".pdf");
  
  try {
    writeFileSync(tmpFile, docxBuffer);
    execSync(`libreoffice --headless --convert-to pdf --outdir "${tmpDir}" "${tmpFile}"`, {
      timeout: 30000,
      stdio: "pipe",
    });
    
    if (existsSync(pdfFile)) {
      const pdf = readFileSync(pdfFile);
      try { unlinkSync(tmpFile); } catch {}
      try { unlinkSync(pdfFile); } catch {}
      return pdf;
    }
    
    console.warn("[ContractEngine] LibreOffice produced no PDF — returning DOCX");
    try { unlinkSync(tmpFile); } catch {}
    return docxBuffer;
  } catch (e: any) {
    console.warn("[ContractEngine] LibreOffice not available — returning DOCX:", e.message);
    try { unlinkSync(tmpFile); } catch {}
    return docxBuffer;
  }
}

// ===== AMORTIZATION CALCULATOR (German method) =====

interface AmortRow {
  mes: number; saldo: number; principal: number; interes: number; cuota: number;
  recaudoGnv: number; diferencial: number; pagoBolsillo: number; fgAcum: number;
}

function calcAmortization(precioContado: number, tasaAnual: number = 0.299, plazoMeses: number = 36, anticipo: number = 50000, mesAnticipo: number = 2, gnvRevenue: number = 4400, fgMensual: number = 334, fgInicial: number = 8000): AmortRow[] {
  const rows: AmortRow[] = [];
  let saldo = precioContado;
  let fgAcum = fgInicial;
  const tasaMensual = tasaAnual / 12;
  
  for (let mes = 1; mes <= plazoMeses; mes++) {
    let principal: number;
    if (mes <= mesAnticipo) {
      principal = Math.round(precioContado / plazoMeses);
    } else {
      if (mes === mesAnticipo + 1) {
        // After anticipo
        saldo -= anticipo;
      }
      principal = Math.round(saldo / (plazoMeses - mes + 1));
    }
    
    const interes = Math.round(saldo * tasaMensual);
    const cuota = principal + interes;
    const diferencial = Math.max(0, cuota - gnvRevenue);
    fgAcum = Math.min(20000, fgAcum + fgMensual);
    const pagoBolsillo = diferencial + (fgAcum < 20000 ? fgMensual : 0);
    
    rows.push({ mes, saldo, principal, interes, cuota, recaudoGnv: gnvRevenue, diferencial, pagoBolsillo, fgAcum });
    saldo -= principal;
  }
  
  return rows;
}

// ===== CONTRACT GENERATORS =====

/** CMU-TSR: Contrato de Compraventa a Plazos con Reserva de Dominio */
export async function generateTSR(orig: any, taxista: any, vehicle: any, aval: any, kitGnv: any): Promise<Buffer> {
  const precioContado = vehicle?.cmu_valor || vehicle?.cmuValor || 200000;
  const amort = calcAmortization(precioContado);
  
  const data = {
    folio: orig?.folio || "CMU-TSR-______",
    folio_val: orig?.folio?.replace("SIN", "VAL") || "CMU-VAL-______",
    fecha_firma: fmtDate(new Date()),
    // Comprador
    comprador_nombre: fullName(taxista),
    comprador_curp: safe(taxista?.curp),
    comprador_rfc: safe(taxista?.rfc),
    comprador_ine: safe(taxista?.ine_numero || safeJson(orig?.datos_ine || orig?.datosIne, "clave_elector")),
    comprador_domicilio: safe(taxista?.direccion),
    comprador_telefono: safe(taxista?.telefono),
    comprador_clabe: safe(taxista?.clabe || safeJson(orig?.datos_estado_cuenta || orig?.datosEstadoCuenta, "clabe")),
    comprador_banco: safe(taxista?.banco || safeJson(orig?.datos_estado_cuenta || orig?.datosEstadoCuenta, "banco")),
    comprador_concesion: safe(safeJson(orig?.datos_concesion || orig?.datosConcesion, "numero_concesion")),
    comprador_municipio: safe(safeJson(orig?.datos_concesion || orig?.datosConcesion, "municipio"), "Aguascalientes"),
    // Aval
    aval_nombre: aval ? fullName(aval) : "____________",
    aval_ine: safe(aval?.ine_numero),
    aval_domicilio: safe(aval?.domicilio),
    aval_telefono: safe(aval?.telefono),
    // Vehículo
    v_marca: safe(vehicle?.marca),
    v_modelo: safe(vehicle?.modelo),
    v_version: safe(vehicle?.version || vehicle?.variante),
    v_anio: safe(vehicle?.anio),
    v_niv: safe(vehicle?.niv || vehicle?.num_serie || vehicle?.numSerie),
    v_motor: safe(vehicle?.num_motor || vehicle?.numMotor),
    v_color: safe(vehicle?.color),
    v_placas: safe(vehicle?.placas),
    v_transmision: safe(vehicle?.transmision, "Manual"),
    v_odometro: safe(vehicle?.odometro_entrega),
    // Financiero
    precio_contado: fmtMoney(precioContado),
    precio_plazos: fmtMoney(Math.round(precioContado * 1.237)),
    cuota_mes1: fmtMoney(amort[0]?.cuota),
    cuota_mes3: fmtMoney(amort[2]?.cuota),
    cuota_mes36: fmtMoney(amort[35]?.cuota),
    anticipo: fmtMoney(50000),
    fg_inicial: fmtMoney(8000),
    fg_mensual: fmtMoney(334),
    fg_techo: fmtMoney(20000),
    tasa_anual: "29.9%",
    plazo: "36",
    gnv_tarifa: "$11.00/LEQ",
    gnv_recaudo: fmtMoney(4400),
    clabe_cmu: "152680120000787681",
    // Kit GNV
    kit_opcion: orig?.tanque_gnv_disponible ? "A (tanque propio)" : "B (sin tanque)",
    kit_precio: fmtMoney(orig?.tanque_gnv_disponible ? 18000 : 27400),
    kit_marca: safe(kitGnv?.marca_kit),
    kit_serie: safe(kitGnv?.num_serie_kit),
    // Amortización (for Anexo B)
    amort_rows: amort,
  };

  return fillTemplate("CMU-TSR.docx", data);
}

/** CMU-PAG: Pagaré de Anticipo a Capital */
export async function generatePAG(orig: any, taxista: any, vehicle: any): Promise<Buffer> {
  const precioContado = vehicle?.cmu_valor || vehicle?.cmuValor || 200000;
  
  const data = {
    folio: orig?.folio?.replace("SIN", "PAG") || "CMU-PAG-______",
    fecha: fmtDate(new Date()),
    comprador_nombre: fullName(taxista),
    comprador_domicilio: safe(taxista?.direccion),
    comprador_ine: safe(taxista?.ine_numero || safeJson(orig?.datos_ine || orig?.datosIne, "clave_elector")),
    monto: fmtMoney(50000),
    monto_letra: "CINCUENTA MIL PESOS 00/100 M.N.",
    v_marca: safe(vehicle?.marca),
    v_modelo: safe(vehicle?.modelo),
    v_anio: safe(vehicle?.anio),
    v_niv: safe(vehicle?.niv || vehicle?.num_serie || vehicle?.numSerie),
    plazo_dias: "56",
    tasa_moratoria: "44.85%",
    clabe_cmu: "152680120000787681",
    folio_tsr: orig?.folio || "CMU-TSR-______",
  };

  return fillTemplate("CMU-PAG.docx", data);
}

/** CMU-CER: Carta de Entrega-Recepción del Vehículo */
export async function generateCER(orig: any, taxista: any, vehicle: any, kitGnv: any): Promise<Buffer> {
  const data = {
    folio: orig?.folio?.replace("SIN", "CER") || "CMU-CER-______",
    fecha: fmtDate(new Date()),
    comprador_nombre: fullName(taxista),
    // Vehículo
    v_marca: safe(vehicle?.marca),
    v_modelo: safe(vehicle?.modelo),
    v_version: safe(vehicle?.version || vehicle?.variante),
    v_anio: safe(vehicle?.anio),
    v_niv: safe(vehicle?.niv || vehicle?.num_serie || vehicle?.numSerie),
    v_motor: safe(vehicle?.num_motor || vehicle?.numMotor),
    v_color: safe(vehicle?.color),
    v_placas: safe(vehicle?.placas),
    v_transmision: safe(vehicle?.transmision, "Manual"),
    v_odometro: safe(vehicle?.odometro_entrega),
    // Kit GNV
    kit_marca: safe(kitGnv?.marca_kit),
    kit_modelo: safe(kitGnv?.modelo_kit),
    kit_serie: safe(kitGnv?.num_serie_kit),
    kit_tipo_tanque: safe(kitGnv?.tipo_tanque),
    kit_serie_tanque: safe(kitGnv?.num_serie_tanque),
    kit_capacidad: safe(kitGnv?.capacidad_tanque_litros),
    kit_fecha_instalacion: fmtDateShort(kitGnv?.fecha_instalacion),
    kit_certificado: safe(kitGnv?.num_certificado_instalacion),
    kit_taller: safe(kitGnv?.taller_instalador),
    folio_tsr: orig?.folio || "CMU-TSR-______",
  };

  return fillTemplate("CMU-CER.docx", data);
}

/** CMU-CTK: Carta de Entrega de Tanque GNV */
export async function generateCTK(orig: any, taxista: any, kitGnv: any): Promise<Buffer> {
  const data = {
    folio: orig?.folio?.replace("SIN", "CTK") || "CMU-CTK-______",
    fecha: fmtDate(new Date()),
    comprador_nombre: fullName(taxista),
    vehiculo_origen: safe(kitGnv?.vehiculo_origen_tanque),
    tipo_tanque: safe(kitGnv?.tipo_tanque),
    serie_tanque: safe(kitGnv?.num_serie_tanque),
    capacidad: safe(kitGnv?.capacidad_tanque_litros),
    dictamen: safe(kitGnv?.dictamen_tanque),
    fecha_inspeccion: fmtDateShort(kitGnv?.fecha_inspeccion_tanque),
    taller: safe(kitGnv?.taller_instalador),
    observaciones: safe(kitGnv?.observaciones, ""),
  };

  return fillTemplate("CMU-CTK.docx", data);
}

/** CMU-REST: Convenio de Reestructura de Deuda */
export async function generateREST(orig: any, taxista: any, aval: any, credito: any): Promise<Buffer> {
  const data = {
    folio: orig?.folio?.replace("SIN", "REST") || "CMU-REST-______",
    fecha: fmtDate(new Date()),
    comprador_nombre: fullName(taxista),
    comprador_ine: safe(taxista?.ine_numero || safeJson(orig?.datos_ine || orig?.datosIne, "clave_elector")),
    aval_nombre: aval ? fullName(aval) : "____________",
    aval_ine: safe(aval?.ine_numero),
    // Situación actual del crédito (from Airtable)
    saldo_capital: fmtMoney(credito?.["Saldo Capital"]),
    cuota_actual: fmtMoney(credito?.["Cuota Actual"]),
    mes_actual: safe(credito?.["Mes Actual"]),
    dias_atraso: safe(credito?.["Dias Atraso"]),
    mora_acumulada: fmtMoney(credito?.["Mora Acumulada"]),
    saldo_fg: fmtMoney(credito?.["Saldo FG"]),
    folio_tsr: orig?.folio || "CMU-TSR-______",
  };

  return fillTemplate("CMU-REST.docx", data);
}

/** CMU-RES: Acta de Rescisión y Recuperación */
export async function generateRES(orig: any, taxista: any, vehicle: any, credito: any): Promise<Buffer> {
  const data = {
    folio: orig?.folio?.replace("SIN", "RES") || "CMU-RES-______",
    fecha: fmtDate(new Date()),
    comprador_nombre: fullName(taxista),
    comprador_domicilio: safe(taxista?.direccion),
    v_marca: safe(vehicle?.marca),
    v_modelo: safe(vehicle?.modelo),
    v_anio: safe(vehicle?.anio),
    v_niv: safe(vehicle?.niv || vehicle?.num_serie || vehicle?.numSerie),
    v_placas: safe(vehicle?.placas),
    saldo_capital: fmtMoney(credito?.["Saldo Capital"]),
    dias_atraso: safe(credito?.["Dias Atraso"]),
    mora_acumulada: fmtMoney(credito?.["Mora Acumulada"]),
    meses_pagados: safe(credito?.["Meses Pagados"]),
    saldo_fg: fmtMoney(credito?.["Saldo FG"]),
    folio_tsr: orig?.folio || "CMU-TSR-______",
  };

  return fillTemplate("CMU-RES.docx", data);
}

/** CMU-LIQ: Convenio de Liquidación Anticipada */
export async function generateLIQ(orig: any, taxista: any, vehicle: any, credito: any): Promise<Buffer> {
  const saldoCapital = credito?.["Saldo Capital"] || 0;
  const interesesDev = credito?.["Intereses Devengados"] || 0;
  const moraAcum = credito?.["Mora Acumulada"] || 0;
  const saldoFG = credito?.["Saldo FG"] || 0;
  const montoLiquidacion = saldoCapital + interesesDev + moraAcum;
  const montoNeto = montoLiquidacion - saldoFG;

  const data = {
    folio: orig?.folio?.replace("SIN", "LIQ") || "CMU-LIQ-______",
    fecha: fmtDate(new Date()),
    comprador_nombre: fullName(taxista),
    comprador_ine: safe(taxista?.ine_numero || safeJson(orig?.datos_ine || orig?.datosIne, "clave_elector")),
    v_marca: safe(vehicle?.marca),
    v_modelo: safe(vehicle?.modelo),
    v_anio: safe(vehicle?.anio),
    v_niv: safe(vehicle?.niv || vehicle?.num_serie || vehicle?.numSerie),
    // Liquidación
    saldo_capital: fmtMoney(saldoCapital),
    intereses_devengados: fmtMoney(interesesDev),
    mora_acumulada: fmtMoney(moraAcum),
    monto_liquidacion: fmtMoney(montoLiquidacion),
    saldo_fg: fmtMoney(saldoFG),
    monto_neto: fmtMoney(Math.max(0, montoNeto)),
    mes_actual: safe(credito?.["Mes Actual"]),
    meses_pagados: safe(credito?.["Meses Pagados"]),
    comprador_clabe: safe(taxista?.clabe),
    comprador_banco: safe(taxista?.banco),
    folio_tsr: orig?.folio || "CMU-TSR-______",
  };

  return fillTemplate("CMU-LIQ.docx", data);
}

/** CMU-ADD-PRO: Addendum de Prórroga del Anticipo */
export async function generateADDPRO(orig: any, taxista: any): Promise<Buffer> {
  const data = {
    folio: orig?.folio?.replace("SIN", "ADD-PRO") || "CMU-ADD-PRO-______",
    fecha: fmtDate(new Date()),
    comprador_nombre: fullName(taxista),
    comprador_ine: safe(taxista?.ine_numero || safeJson(orig?.datos_ine || orig?.datosIne, "clave_elector")),
    anticipo: fmtMoney(50000),
    plazo_original: "56 días",
    folio_tsr: orig?.folio || "CMU-TSR-______",
  };

  return fillTemplate("CMU-ADD-PRO.docx", data);
}

/** CMU-VAL: Convenio de Validación Operativa */
/**
 * CMU-AVP — Aviso de Privacidad Integral.
 *
 * Produces a DOCX with the full v2 Aviso text plus a frozen acceptance
 * constancy (fecha, OTP SID, IP, User Agent). Used as legal proof of
 * consent at the moment of aceptación. Extra fields allow the caller
 * (avp-engine.ts) to stamp metadata that isn’t part of the standard
 * origination record.
 */
export async function generateAVP(
  orig: any,
  taxista: any,
  extra: Record<string, any> = {},
): Promise<Buffer> {
  const data = {
    folio_avp: extra.folio_avp || orig?.folio || "CMU-AVP-______",
    version: extra.version || "v3",
    vigente_desde: extra.vigente_desde || "2026-04-22",
    folio_val: extra.folio_val || orig?.folio_val || orig?.folio || "CMU-VAL-______",
    operador_nombre: fullName(taxista),
    operador_ine: safe(taxista?.ine_numero || safeJson(orig?.datos_ine || orig?.datosIne, "clave_elector")),
    operador_curp: safe(taxista?.curp || safeJson(orig?.datos_ine || orig?.datosIne, "curp")),
    operador_telefono: safe(taxista?.telefono || orig?.otpPhone || orig?.otp_phone),
    fecha_aceptacion: extra.fecha_aceptacion || new Date().toISOString(),
    otp_sid: extra.otp_sid || "N/A",
    ip_aceptacion: extra.ip_aceptacion || "N/A",
    user_agent: extra.user_agent || "N/A",
    consent_secundarias: extra.consent_secundarias
      ?? "(capturado al momento de la aceptaci\u00f3n)",
  };

  return fillTemplate("CMU-AVP.docx", data);
}

export async function generateVAL(orig: any, taxista: any): Promise<Buffer> {
  const data = {
    folio: orig?.folio?.replace("SIN", "VAL") || "CMU-VAL-______",
    fecha: fmtDate(new Date()),
    operador_nombre: fullName(taxista),
    operador_curp: safe(taxista?.curp),
    operador_rfc: safe(taxista?.rfc),
    operador_ine: safe(taxista?.ine_numero || safeJson(orig?.datos_ine || orig?.datosIne, "clave_elector")),
    operador_domicilio: safe(taxista?.direccion),
    operador_telefono: safe(taxista?.telefono),
    concesion: safe(safeJson(orig?.datos_concesion || orig?.datosConcesion, "numero_concesion")),
    municipio: safe(safeJson(orig?.datos_concesion || orig?.datosConcesion, "municipio"), "Aguascalientes"),
    perfil: orig?.perfil_tipo || orig?.perfilTipo || "A",
    tanque_disponible: orig?.tanque_gnv_disponible ? "Sí" : "No",
    observaciones: safe(orig?.observaciones, ""),
  };

  return fillTemplate("CMU-VAL.docx", data);
}

/** Get list of available template types */
export function getAvailableTemplates(): string[] {
  return ["TSR", "PAG", "CER", "CTK", "REST", "RES", "LIQ", "ADD-PRO", "VAL", "AVP"];
}
