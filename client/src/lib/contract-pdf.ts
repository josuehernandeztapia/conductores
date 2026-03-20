/**
 * Client-side PDF generator using jsPDF.
 * Replaces server/contract-pdf.ts (PDFKit) with browser-native generation.
 * 
 * Generates two contract types:
 * 1. Convenio de Validación (8 clauses, ~3 pages)
 * 2. Contrato de Compraventa a Plazos (10 clauses + pagaré + checklist, ~8 pages)
 */

import { jsPDF } from "jspdf";
import type { Origination, Taxista, VehicleInventory } from "@shared/schema";

// ===== CONSTANTS =====
const EMPRESA = {
  nombre: "CONDUCTORES DEL MUNDO, S.A.P.I. DE C.V.",
  rfc: "CMU201119DD6",
  domicilio: "Lago de Chapultepec 6-40, Cañadas del Lago, Corregidora, Querétaro",
  ciudad: "Aguascalientes, Ags.",
  representante: "Ángeles Mireles",
};

const PLAZOS = {
  markup: 1.237,
  tasaAnual: 0.299,
  meses: 36,
  anticipo: 50000,
  mesAnticipo: 2,
  gnvRevenue: 4400,
  fondoInicial: 8000,
  fondoMensual: 334,
};

const BANCREA_CLABE = "152680120000787681";

// Page dimensions (Letter in mm)
const PAGE_W = 215.9;
const PAGE_H = 279.4;
const MARGIN_L = 20;
const MARGIN_R = 20;
const MARGIN_T = 18;
const MARGIN_B = 20;
const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;

// ===== HELPERS =====
function fmtMoney(n: number): string {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "____________";
  const d = new Date(iso);
  const months = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  return `${d.getDate()} de ${months[d.getMonth()]} de ${d.getFullYear()}`;
}

function safeGet(json: string | null, key: string): string {
  if (!json) return "____________";
  try {
    const obj = JSON.parse(json);
    return obj[key] || "____________";
  } catch {
    return "____________";
  }
}

function fullName(json: string | null): string {
  if (!json) return "____________";
  try {
    const obj = JSON.parse(json);
    const parts = [obj.nombre, obj.apellido_paterno, obj.apellido_materno].filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : "____________";
  } catch {
    return "____________";
  }
}

function numberToWords(n: number): string {
  if (n === 0) return "cero";
  const units = ["","uno","dos","tres","cuatro","cinco","seis","siete","ocho","nueve"];
  const teens = ["diez","once","doce","trece","catorce","quince","dieciséis","diecisiete","dieciocho","diecinueve"];
  const tens = ["","diez","veinte","treinta","cuarenta","cincuenta","sesenta","setenta","ochenta","noventa"];
  const hundreds = ["","ciento","doscientos","trescientos","cuatrocientos","quinientos","seiscientos","setecientos","ochocientos","novecientos"];

  function chunk(num: number): string {
    if (num === 0) return "";
    if (num === 100) return "cien";
    if (num < 10) return units[num];
    if (num < 20) return teens[num - 10];
    if (num < 30) return num === 20 ? "veinte" : `veinti${units[num - 20]}`;
    if (num < 100) {
      const t = Math.floor(num / 10);
      const u = num % 10;
      return u === 0 ? tens[t] : `${tens[t]} y ${units[u]}`;
    }
    if (num < 1000) {
      const h = Math.floor(num / 100);
      const rest = num % 100;
      return rest === 0 ? (num === 100 ? "cien" : hundreds[h]) : `${hundreds[h]} ${chunk(rest)}`;
    }
    return String(num);
  }

  const parts: string[] = [];
  let remaining = n;
  if (remaining >= 1000000) {
    const m = Math.floor(remaining / 1000000);
    remaining = remaining % 1000000;
    parts.push(m === 1 ? "un millón" : `${chunk(m)} millones`);
  }
  if (remaining >= 1000) {
    const k = Math.floor(remaining / 1000);
    remaining = remaining % 1000;
    parts.push(k === 1 ? "mil" : `${chunk(k)} mil`);
  }
  if (remaining > 0) {
    parts.push(chunk(remaining));
  }
  return parts.join(" ") || "cero";
}

// ===== jsPDF Helpers (cursor-based, no global mutable) =====
type Cursor = { y: number };

function checkPage(doc: jsPDF, cur: Cursor, needed: number) {
  if (cur.y + needed > PAGE_H - MARGIN_B) {
    doc.addPage();
    cur.y = MARGIN_T;
  }
}

function addHeader(doc: jsPDF, cur: Cursor, title: string, folio: string) {
  cur.y = MARGIN_T;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(EMPRESA.nombre, PAGE_W / 2, cur.y, { align: "center" });
  cur.y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text(`RFC: ${EMPRESA.rfc}`, PAGE_W / 2, cur.y, { align: "center" });
  cur.y += 4;
  doc.setFontSize(7);
  doc.text(EMPRESA.domicilio, PAGE_W / 2, cur.y, { align: "center" });
  cur.y += 7;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text(title, PAGE_W / 2, cur.y, { align: "center" });
  cur.y += 4;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text(`Folio: ${folio}`, PAGE_W / 2, cur.y, { align: "center" });
  cur.y += 8;
}

function addParagraph(doc: jsPDF, cur: Cursor, text: string, fontSize = 8) {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(fontSize);
  const lines = doc.splitTextToSize(text, CONTENT_W);
  const lineHeight = fontSize * 0.45;
  
  for (const line of lines) {
    checkPage(doc, cur, lineHeight + 1);
    doc.text(line, MARGIN_L, cur.y);
    cur.y += lineHeight;
  }
  cur.y += 2;
}

function addBoldParagraph(doc: jsPDF, cur: Cursor, text: string, fontSize = 8) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(fontSize);
  const lines = doc.splitTextToSize(text, CONTENT_W);
  const lineHeight = fontSize * 0.45;
  
  for (const line of lines) {
    checkPage(doc, cur, lineHeight + 1);
    doc.text(line, MARGIN_L, cur.y);
    cur.y += lineHeight;
  }
  cur.y += 2;
}

function addClause(doc: jsPDF, cur: Cursor, number: string, title: string, body: string) {
  checkPage(doc, cur, 12);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text(`${number}.- ${title}`, MARGIN_L, cur.y);
  cur.y += 5;
  addParagraph(doc, cur, body);
  cur.y += 2;
}

function addSignatureBlock(doc: jsPDF, cur: Cursor, names: { label: string; name: string }[]) {
  checkPage(doc, cur, 30);
  cur.y += 15;
  const colWidth = CONTENT_W / names.length;
  
  names.forEach((n, i) => {
    const x = MARGIN_L + (i * colWidth) + colWidth / 2;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.text("_____________________________", x, cur.y, { align: "center" });
    doc.text(n.name, x, cur.y + 4, { align: "center" });
    doc.setFontSize(6);
    doc.text(n.label, x, cur.y + 7, { align: "center" });
  });
  cur.y += 12;
}

function addWitnessBlock(doc: jsPDF, cur: Cursor) {
  checkPage(doc, cur, 30);
  cur.y += 15;
  const colWidth = CONTENT_W / 2;
  
  ["TESTIGO 1", "TESTIGO 2"].forEach((label, i) => {
    const x = MARGIN_L + (i * colWidth) + colWidth / 2;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.text("_____________________________", x, cur.y, { align: "center" });
    doc.text("Nombre: _____________________", x, cur.y + 4, { align: "center" });
    doc.setFontSize(6);
    doc.text(label, x, cur.y + 7, { align: "center" });
  });
  cur.y += 12;
}

function addFooter(doc: jsPDF, folio: string) {
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6);
    doc.setTextColor(150, 150, 150);
    doc.text(
      `${folio} — Generado el ${fmtDate(new Date().toISOString())} — ${EMPRESA.nombre} — Pág. ${i}/${pageCount}`,
      PAGE_W / 2, PAGE_H - 10, { align: "center" }
    );
    doc.setTextColor(0, 0, 0);
  }
}

// ===== CONVENIO DE VALIDACIÓN =====
export function generateConvenioValidacion(
  orig: Origination,
  taxista: Taxista | null,
  vehicle: VehicleInventory | null,
): Blob {
  const doc = new jsPDF({ format: "letter", unit: "mm" });
  const cur: Cursor = { y: MARGIN_T };

  const nombre = taxista
    ? `${taxista.nombre} ${taxista.apellidoPaterno} ${taxista.apellidoMaterno || ""}`.trim()
    : fullName(orig.datosIne);
  const curp = taxista?.curp || safeGet(orig.datosIne, "curp");
  const rfc = taxista?.rfc || safeGet(orig.datosCsf, "rfc");
  const telefono = taxista?.telefono || orig.otpPhone || "____________";
  const domicilio = taxista?.direccion || safeGet(orig.datosComprobante, "direccion");
  const concesion = safeGet(orig.datosConcesion, "numero_concesion");
  const vMarca = vehicle?.marca || safeGet(orig.datosFactura, "marca");
  const vModelo = vehicle?.modelo || safeGet(orig.datosFactura, "modelo");
  const vAnio = vehicle?.anio?.toString() || safeGet(orig.datosFactura, "anio");
  const vSerie = vehicle?.numSerie || safeGet(orig.datosFactura, "num_serie");

  addHeader(doc, cur, "CONVENIO DE VALIDACIÓN", orig.folio);

  // --- LUGAR Y FECHA ---
  addParagraph(doc, cur,
    `En la ciudad de ${EMPRESA.ciudad}, a ${fmtDate(new Date().toISOString())}, celebran el presente Convenio de Validación las siguientes partes:`
  );

  // --- DECLARACIONES ---
  checkPage(doc, cur, 10);
  addBoldParagraph(doc, cur, "DECLARACIONES", 10);

  addBoldParagraph(doc, cur, "I. Declara \"CMU\" por conducto de su representante:");
  addParagraph(doc, cur,
    `a) Que es una sociedad denominada ${EMPRESA.nombre}, con RFC ${EMPRESA.rfc}, constituida conforme a las leyes de los Estados Unidos Mexicanos.\nb) Que tiene su domicilio social en ${EMPRESA.domicilio}.\nc) Que su representante, ${EMPRESA.representante}, cuenta con facultades suficientes para celebrar el presente convenio.\nd) Que dentro de su objeto social se encuentra la adquisición, rehabilitación y comercialización de vehículos automotores siniestrados.`
  );

  addBoldParagraph(doc, cur, "II. Declara \"EL OPERADOR\":");
  addParagraph(doc, cur,
    `a) Que su nombre es ${nombre}, con CURP ${curp} y RFC ${rfc}.\nb) Que tiene su domicilio en ${domicilio}.\nc) Que su teléfono de contacto es ${telefono}.\nd) Que es titular de la concesión de servicio de transporte público (taxi) número ${concesion} otorgada por el Gobierno del Estado de Aguascalientes.\ne) Que su perfil de consumo es ${orig.perfilTipo === "A" ? "Tipo A (GNV, ≥400 LEQ/mes)" : "Tipo B (Gasolina, tickets ≥$6,000/mes)"}.\nf) Que acepta participar voluntariamente en el programa de validación de CMU y conoce sus términos.`
  );

  // --- CLÁUSULAS ---
  checkPage(doc, cur, 10);
  addBoldParagraph(doc, cur, "CLÁUSULAS", 10);

  addClause(doc, cur, "PRIMERA", "OBJETO",
    `El presente convenio tiene como objeto establecer los términos y condiciones bajo los cuales CMU validará la idoneidad de EL OPERADOR para participar en el programa de adquisición de vehículos siniestrados rehabilitados para servicio de taxi, así como las obligaciones de ambas partes durante el período de validación.`
  );

  addClause(doc, cur, "SEGUNDA", "VEHÍCULO EN VALIDACIÓN",
    `CMU entrega a EL OPERADOR en calidad de comodato el siguiente vehículo:\n\nMarca: ${vMarca}\nModelo: ${vModelo}\nAño: ${vAnio}\nNúmero de serie: ${vSerie}\n\nEl vehículo descrito será entregado en el estado en que se encuentra, habiendo EL OPERADOR realizado la inspección correspondiente. El período de validación no excederá de 30 (treinta) días naturales contados a partir de la firma del presente convenio.`
  );

  addClause(doc, cur, "TERCERA", "OBLIGACIONES DE EL OPERADOR",
    `Durante el período de validación, EL OPERADOR se obliga a:\na) Utilizar el vehículo exclusivamente para servicio de transporte público (taxi) en la ciudad de Aguascalientes, Ags.\nb) Mantener el vehículo en buen estado de conservación y limpieza.\nc) Cubrir los gastos de combustible, casetas y mantenimiento menor durante el período.\nd) Reportar de inmediato a CMU cualquier incidente, accidente o falla mecánica.\ne) No prestar, subarrendar ni transferir el uso del vehículo a terceros sin autorización escrita de CMU.\nf) Devolver el vehículo al término del período de validación en las mismas condiciones en que fue recibido, salvo el desgaste normal por uso.\ng) Cumplir con el consumo mínimo de combustible correspondiente a su perfil.`
  );

  addClause(doc, cur, "CUARTA", "OBLIGACIONES DE CMU",
    `CMU se obliga a:\na) Entregar el vehículo en condiciones mecánicas adecuadas para su operación.\nb) Proporcionar la documentación vehicular necesaria para la circulación legal del vehículo.\nc) Mantener vigente la póliza de seguro de responsabilidad civil durante el período de validación.\nd) Evaluar de manera objetiva y transparente el desempeño de EL OPERADOR.`
  );

  addClause(doc, cur, "QUINTA", "FONDO DE GARANTÍA",
    `EL OPERADOR acepta depositar un fondo de garantía inicial de ${fmtMoney(PLAZOS.fondoInicial)} (${numberToWords(PLAZOS.fondoInicial)} pesos 00/100 M.N.) previo a la entrega del vehículo, mediante transferencia bancaria a la cuenta CLABE ${BANCREA_CLABE} (Bancrea) a nombre de ${EMPRESA.nombre}. Este fondo será aplicado como parte del anticipo en caso de formalizar la compraventa a plazos, o devuelto íntegramente dentro de los 5 (cinco) días hábiles siguientes a la devolución del vehículo en caso de no continuar con el programa.`
  );

  addClause(doc, cur, "SEXTA", "EVALUACIÓN Y RESULTADO",
    `Al término del período de validación, CMU evaluará el desempeño de EL OPERADOR con base en:\na) Cumplimiento del perfil de consumo mínimo establecido según su categoría.\nb) Estado general del vehículo al momento de la devolución.\nc) Cumplimiento de las obligaciones descritas en la cláusula TERCERA.\nd) Historial de pagos y cumplimiento durante el período.\n\nCon base en esta evaluación, CMU emitirá un dictamen de "APROBADO" o "NO APROBADO" para proceder a la formalización del Contrato de Compraventa a Plazos. El dictamen será notificado a EL OPERADOR dentro de los 3 (tres) días hábiles siguientes al término del período de validación.`
  );

  addClause(doc, cur, "SÉPTIMA", "TERMINACIÓN ANTICIPADA",
    `Cualquiera de las partes podrá dar por terminado el presente convenio en cualquier momento, notificando por escrito a la otra parte con al menos 5 (cinco) días naturales de anticipación. En caso de terminación anticipada por parte de EL OPERADOR, este se obliga a devolver el vehículo dentro de las 48 (cuarenta y ocho) horas siguientes a la notificación, en las mismas condiciones en que lo recibió, salvo el desgaste normal. CMU podrá dar por terminado el convenio de manera inmediata en caso de incumplimiento grave de las obligaciones de EL OPERADOR.`
  );

  addClause(doc, cur, "OCTAVA", "RESPONSABILIDAD CIVIL",
    `EL OPERADOR será responsable de cualquier daño causado a terceros durante la operación del vehículo en el período de validación. CMU mantendrá vigente una póliza de seguro de responsabilidad civil; sin embargo, el deducible y cualquier monto no cubierto por el seguro será responsabilidad de EL OPERADOR.`
  );

  addClause(doc, cur, "NOVENA", "CONFIDENCIALIDAD",
    `Las partes se obligan a mantener en estricta confidencialidad toda la información que obtengan con motivo de la celebración y ejecución del presente convenio, incluyendo datos personales, información financiera y condiciones comerciales.`
  );

  addClause(doc, cur, "DÉCIMA", "JURISDICCIÓN Y LEGISLACIÓN APLICABLE",
    `Para la interpretación, cumplimiento y ejecución del presente convenio, las partes se someten expresamente a la jurisdicción de los tribunales competentes de la ciudad de Aguascalientes, estado de Aguascalientes, renunciando a cualquier otro fuero que por razón de domicilio presente o futuro pudiera corresponderles. En lo no previsto por este convenio, serán aplicables las disposiciones del Código Civil del Estado de Aguascalientes y demás legislación aplicable.`
  );

  // --- FIRMAS ---
  addParagraph(doc, cur,
    "Leído que fue el presente convenio y enteradas las partes de su contenido y alcance legal, lo firman por duplicado en la ciudad y fecha indicadas al inicio del presente documento."
  );

  addSignatureBlock(doc, cur, [
    { label: "EL OPERADOR", name: nombre },
    { label: "POR CMU", name: EMPRESA.representante },
  ]);

  addWitnessBlock(doc, cur);

  addFooter(doc, orig.folio);
  return doc.output("blob");
}

// ===== CONTRATO DE COMPRAVENTA A PLAZOS =====
export function generateContratoCompraventa(
  orig: Origination,
  taxista: Taxista | null,
  vehicle: VehicleInventory | null,
): Blob {
  const doc = new jsPDF({ format: "letter", unit: "mm" });
  const cur: Cursor = { y: MARGIN_T };

  const nombre = taxista
    ? `${taxista.nombre} ${taxista.apellidoPaterno} ${taxista.apellidoMaterno || ""}`.trim()
    : fullName(orig.datosIne);
  const curp = taxista?.curp || safeGet(orig.datosIne, "curp");
  const rfc = taxista?.rfc || safeGet(orig.datosCsf, "rfc");
  const telefono = taxista?.telefono || orig.otpPhone || "____________";
  const domicilio = taxista?.direccion || safeGet(orig.datosComprobante, "direccion");
  const concesion = safeGet(orig.datosConcesion, "numero_concesion");

  const vMarca = vehicle?.marca || safeGet(orig.datosFactura, "marca");
  const vModelo = vehicle?.modelo || safeGet(orig.datosFactura, "modelo");
  const vAnio = vehicle?.anio?.toString() || safeGet(orig.datosFactura, "anio");
  const vSerie = vehicle?.numSerie || safeGet(orig.datosFactura, "num_serie");
  const vNiv = vehicle?.niv || safeGet(orig.datosFactura, "niv");
  const vMotor = vehicle?.numMotor || "____________";
  const vColor = vehicle?.color || "____________";

  const cmuVal = vehicle?.cmuValor || 200000;
  const ventaPlazos = Math.round(cmuVal * PLAZOS.markup);
  const montoFinanciar = ventaPlazos - PLAZOS.anticipo;
  const tasaMensual = PLAZOS.tasaAnual / 12;
  const mensualidad = Math.round(montoFinanciar * (tasaMensual * Math.pow(1 + tasaMensual, PLAZOS.meses)) / (Math.pow(1 + tasaMensual, PLAZOS.meses) - 1));
  const totalPagar = PLAZOS.anticipo + (mensualidad * PLAZOS.meses);

  addHeader(doc, cur, "CONTRATO DE COMPRAVENTA A PLAZOS", orig.folio);

  // --- LUGAR Y FECHA ---
  addParagraph(doc, cur,
    `En la ciudad de ${EMPRESA.ciudad}, a ${fmtDate(new Date().toISOString())}, celebran el presente Contrato de Compraventa a Plazos las siguientes partes:`
  );

  // --- DECLARACIONES ---
  checkPage(doc, cur, 10);
  addBoldParagraph(doc, cur, "DECLARACIONES", 10);

  addBoldParagraph(doc, cur, "I. Declara \"EL VENDEDOR\" por conducto de su representante:");
  addParagraph(doc, cur,
    `a) Que es una Sociedad Anónima Promotora de Inversión de Capital Variable denominada ${EMPRESA.nombre}, constituida conforme a las leyes de los Estados Unidos Mexicanos, con RFC ${EMPRESA.rfc}.\nb) Que tiene su domicilio social en ${EMPRESA.domicilio}.\nc) Que su representante, ${EMPRESA.representante}, cuenta con las facultades necesarias para celebrar el presente contrato.\nd) Que es legítimo propietario del vehículo objeto de este contrato, el cual se encuentra libre de todo gravamen, embargo, litigio o limitación de dominio.\ne) Que el vehículo es de procedencia lícita, habiendo sido adquirido de compañía aseguradora como vehículo siniestrado y rehabilitado conforme a los estándares de calidad de EL VENDEDOR.`
  );

  addBoldParagraph(doc, cur, "II. Declara \"EL COMPRADOR\":");
  addParagraph(doc, cur,
    `a) Que su nombre completo es ${nombre}, con CURP ${curp} y RFC ${rfc}.\nb) Que tiene su domicilio en ${domicilio}.\nc) Que su teléfono de contacto es ${telefono}.\nd) Que es titular de la concesión de servicio de transporte público (taxi) número ${concesion} otorgada por el Gobierno del Estado de Aguascalientes.\ne) Que ha sido informado de manera completa sobre las condiciones del vehículo, su origen como vehículo siniestrado rehabilitado, y acepta adquirirlo en el estado en que se encuentra.\nf) Que cuenta con la capacidad legal y económica para cumplir con las obligaciones derivadas del presente contrato.\ng) Que su perfil de consumo es ${orig.perfilTipo === "A" ? "Tipo A (GNV, ≥400 LEQ/mes)" : "Tipo B (Gasolina, tickets ≥$6,000/mes)"}.`
  );

  addBoldParagraph(doc, cur, "III. Declaran ambas partes:");
  addParagraph(doc, cur,
    `a) Que se reconocen mutuamente la personalidad y capacidad legal con la que comparecen.\nb) Que es su libre voluntad celebrar el presente contrato, sin que medie error, dolo, mala fe, violencia o cualquier otro vicio del consentimiento.\nc) Que el presente contrato constituye la totalidad de los acuerdos entre las partes respecto de su objeto.`
  );

  // --- CLÁUSULAS ---
  checkPage(doc, cur, 10);
  addBoldParagraph(doc, cur, "CLÁUSULAS", 10);

  addClause(doc, cur, "PRIMERA", "OBJETO",
    `EL VENDEDOR transmite en favor de EL COMPRADOR la propiedad del vehículo descrito en la cláusula SEGUNDA del presente contrato, sujeto a las condiciones de pago a plazos establecidas en este instrumento. La propiedad plena se transferirá una vez que EL COMPRADOR haya liquidado el 100% (cien por ciento) del precio pactado.`
  );

  addClause(doc, cur, "SEGUNDA", "DESCRIPCIÓN DEL VEHÍCULO",
    `El vehículo objeto del presente contrato tiene las siguientes características:\n\nMarca: ${vMarca}\nLínea/Modelo: ${vModelo}\nAño modelo: ${vAnio}\nColor: ${vColor}\nNúmero de Identificación Vehicular (NIV): ${vNiv}\nNúmero de serie: ${vSerie}\nNúmero de motor: ${vMotor}\n\nEL COMPRADOR declara haber inspeccionado físicamente el vehículo, estar conforme con su estado mecánico y estético, y aceptarlo en las condiciones en que se encuentra.`
  );

  addClause(doc, cur, "TERCERA", "PRECIO Y CONDICIONES DE PAGO",
    `El precio total de venta del vehículo a plazos es de ${fmtMoney(ventaPlazos)} (${numberToWords(ventaPlazos)} pesos 00/100 M.N.), que incluye el costo del vehículo más el factor de financiamiento (markup ×${PLAZOS.markup}). El pago se realizará conforme a lo siguiente:\n\na) Anticipo a Capital: ${fmtMoney(PLAZOS.anticipo)} (${numberToWords(PLAZOS.anticipo)} pesos 00/100 M.N.), pagadero en el mes ${PLAZOS.mesAnticipo} contado a partir de la fecha de entrega del vehículo.\nb) Saldo a financiar: ${fmtMoney(montoFinanciar)}\nc) Plazo: ${PLAZOS.meses} (treinta y seis) mensualidades consecutivas\nd) Tasa de interés anual: ${(PLAZOS.tasaAnual * 100).toFixed(1)}%\ne) Mensualidad fija: ${fmtMoney(mensualidad)}\nf) Total a pagar (anticipo + mensualidades): ${fmtMoney(totalPagar)}\n\nLos pagos deberán realizarse mediante depósito bancario o transferencia electrónica a la cuenta CLABE ${BANCREA_CLABE} (Bancrea) a nombre de ${EMPRESA.nombre}, a más tardar el día 5 (cinco) de cada mes calendario.`
  );

  addClause(doc, cur, "CUARTA", "PROGRAMA DE RECAUDO GNV",
    orig.perfilTipo === "A"
      ? `EL COMPRADOR, al corresponder al perfil de consumo Tipo A (GNV), se compromete a participar en el programa de recaudo de Gas Natural Vehicular (GNV) de CMU. Mediante este programa, CMU retendrá la cantidad de ${fmtMoney(PLAZOS.gnvRevenue)} mensuales del consumo de GNV de EL COMPRADOR. Este monto se aplicará directamente a la mensualidad correspondiente.\n\nFlujo GNV proyectado: ${fmtMoney(PLAZOS.gnvRevenue)}/mes × ${PLAZOS.meses} meses = ${fmtMoney(PLAZOS.gnvRevenue * PLAZOS.meses)}`
      : `EL COMPRADOR, al corresponder al perfil de consumo Tipo B (gasolina), no participará en el programa de recaudo GNV. Las mensualidades deberán cubrirse íntegramente mediante depósito o transferencia bancaria.`
  );

  addClause(doc, cur, "QUINTA", "FONDO DE GARANTÍA",
    `Para garantizar el cumplimiento de las obligaciones, EL COMPRADOR acepta la constitución de un fondo de garantía:\n\na) Aportación inicial: ${fmtMoney(PLAZOS.fondoInicial)}\nb) Aportaciones mensuales: ${fmtMoney(PLAZOS.fondoMensual)} adicionados a cada mensualidad\n\nEl fondo de garantía será devuelto a EL COMPRADOR al momento de liquidar la totalidad del precio de venta, siempre que no existan adeudos pendientes o daños que requieran compensación.`
  );

  addClause(doc, cur, "SEXTA", "RESERVA DE DOMINIO",
    `Conforme a la legislación aplicable, las partes convienen que EL VENDEDOR se reserva el dominio del vehículo hasta que EL COMPRADOR haya cubierto la totalidad del precio pactado. Durante la vigencia de esta reserva:\n\na) EL COMPRADOR no podrá enajenar, gravar ni disponer del vehículo sin autorización expresa de EL VENDEDOR.\nb) EL VENDEDOR podrá inscribir la reserva de dominio ante el Registro Público correspondiente.\nc) Una vez liquidado el precio total, EL VENDEDOR otorgará carta finiquito y documentos para la liberación.`
  );

  addClause(doc, cur, "SÉPTIMA", "OBLIGACIONES DE EL COMPRADOR",
    `EL COMPRADOR se obliga a:\na) Realizar los pagos en tiempo y forma.\nb) Utilizar el vehículo exclusivamente como taxi en la ciudad de Aguascalientes, Ags.\nc) Mantener el vehículo en buen estado de conservación y funcionamiento.\nd) Contratar y mantener vigente un seguro de responsabilidad civil.\ne) No modificar las características del vehículo sin autorización de EL VENDEDOR.\nf) Permitir la inspección del vehículo cuando EL VENDEDOR lo solicite.\ng) Notificar de inmediato cualquier siniestro, robo o daño al vehículo.\nh) Cubrir todos los impuestos, derechos, verificaciones y obligaciones fiscales del vehículo.`
  );

  addClause(doc, cur, "OCTAVA", "CAUSAS DE RESCISIÓN",
    `EL VENDEDOR podrá dar por rescindido el presente contrato sin necesidad de declaración judicial cuando:\n\na) EL COMPRADOR incurra en mora de 2 (dos) o más mensualidades consecutivas.\nb) EL COMPRADOR destine el vehículo a un uso distinto al pactado.\nc) EL COMPRADOR enajene, grave o transfiera el vehículo sin autorización.\nd) Se proporcione información falsa que haya sido determinante para la celebración del contrato.\ne) Se presente cualquier causa que ponga en riesgo la recuperación del crédito.\n\nEn caso de rescisión, EL COMPRADOR deberá devolver el vehículo dentro de las 48 horas siguientes a la notificación. Los pagos realizados serán aplicados a renta proporcional por el uso del vehículo.`
  );

  addClause(doc, cur, "NOVENA", "GASTOS Y CONTRIBUCIONES",
    `Serán por cuenta de EL COMPRADOR todos los gastos de mantenimiento, combustible, verificación vehicular, tenencia, derechos de placa, multas y cualquier otra contribución derivada del uso y posesión del vehículo durante la vigencia del presente contrato.`
  );

  addClause(doc, cur, "DÉCIMA", "PENA CONVENCIONAL",
    `En caso de incumplimiento de las obligaciones de pago, EL COMPRADOR pagará una pena convencional equivalente al 5% mensual sobre el monto vencido y no pagado, sin perjuicio de las demás acciones legales que correspondan.`
  );

  addClause(doc, cur, "DÉCIMA PRIMERA", "JURISDICCIÓN Y LEGISLACIÓN APLICABLE",
    `Para la interpretación, cumplimiento y ejecución del presente contrato, las partes se someten expresamente a la jurisdicción de los tribunales competentes de la ciudad de Aguascalientes, estado de Aguascalientes, renunciando a cualquier otro fuero que por razón de domicilio presente o futuro pudiera corresponderles. En lo no previsto, serán aplicables las disposiciones del Código Civil del Estado de Aguascalientes, el Código de Comercio y demás legislación aplicable.`
  );

  // --- FIRMAS ---
  addParagraph(doc, cur,
    "Leído que fue el presente contrato y enteradas las partes de su contenido y alcance legal, lo firman por duplicado en la ciudad y fecha indicadas, ante la presencia de los testigos que se indican."
  );

  addSignatureBlock(doc, cur, [
    { label: "EL COMPRADOR", name: nombre },
    { label: "EL VENDEDOR", name: EMPRESA.representante },
  ]);

  addWitnessBlock(doc, cur);

  // PAGE: PAGARÉ
  doc.addPage();
  addHeader(doc, cur, "PAGARÉ", `${orig.folio}-PAG`);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Bueno por: ${fmtMoney(totalPagar)}`, PAGE_W - MARGIN_R, cur.y, { align: "right" });
  cur.y += 6;

  addParagraph(doc, cur,
    `En la ciudad de ${EMPRESA.ciudad}, a ${fmtDate(new Date().toISOString())}, debo y pagaré incondicionalmente a la orden de ${EMPRESA.nombre}, con domicilio en ${EMPRESA.domicilio}, la cantidad de ${fmtMoney(totalPagar)} (${numberToWords(totalPagar)} pesos 00/100 M.N.), valor recibido a mi entera satisfacción por la compraventa a plazos del vehículo ${vMarca} ${vModelo} ${vAnio}, serie ${vSerie}.`
  );

  addParagraph(doc, cur,
    `Este pagaré será liquidado en ${PLAZOS.meses} pagos mensuales consecutivos de ${fmtMoney(mensualidad)} cada uno, más un anticipo a capital de ${fmtMoney(PLAZOS.anticipo)} en el mes ${PLAZOS.mesAnticipo}, comenzando a partir del mes siguiente a la firma.`
  );

  addParagraph(doc, cur,
    `En caso de falta de pago oportuno, el saldo insoluto causará intereses moratorios a razón del ${((PLAZOS.tasaAnual * 1.5) * 100).toFixed(1)}% anual, sin perjuicio de las demás acciones legales que correspondan.`
  );

  addParagraph(doc, cur,
    `Lugar de pago: ${EMPRESA.ciudad}\nFecha de vencimiento: ${PLAZOS.meses} meses a partir de la suscripción\n\nSuscriptor:\nNombre: ${nombre}\nCURP: ${curp}\nRFC: ${rfc}\nDomicilio: ${domicilio}\nTeléfono: ${telefono}`
  );

  checkPage(doc, cur, 25);
  cur.y += 12;
  doc.setFontSize(7);
  doc.text("_____________________________", PAGE_W / 2, cur.y, { align: "center" });
  cur.y += 3;
  doc.text(nombre, PAGE_W / 2, cur.y, { align: "center" });
  cur.y += 3;
  doc.text("Firma del suscriptor", PAGE_W / 2, cur.y, { align: "center" });

  // PAGE: ACTA DE ENTREGA-RECEPCIÓN
  doc.addPage();
  addHeader(doc, cur, "ACTA DE ENTREGA-RECEPCIÓN DE VEHÍCULO", orig.folio);

  addParagraph(doc, cur, `Fecha de entrega: ${fmtDate(new Date().toISOString())}`);
  addParagraph(doc, cur, `Entregado a: ${nombre}`);
  addParagraph(doc, cur, `Vehículo: ${vMarca} ${vModelo} ${vAnio} — NIV: ${vNiv} — Serie: ${vSerie}`);
  addParagraph(doc, cur, `Color: ${vColor} — Motor: ${vMotor}`);
  cur.y += 3;

  const checkItems = [
    "Vehículo en condiciones mecánicas de operación",
    "Llaves entregadas (juego principal + copia)",
    "Tarjeta de circulación vigente",
    "Póliza de seguro de responsabilidad civil vigente",
    "Kit de herramienta básica (gato, llave de cruz, triángulos)",
    "Llanta de refacción en buen estado",
    "Verificación vehicular vigente",
    "Calcomanía y registro GNV vigente (si aplica)",
    "Sistema de GNV funcionando correctamente (si aplica)",
    "Tanque de GNV con vigencia de prueba hidrostática (si aplica)",
    "Luces delanteras, traseras y direccionales funcionando",
    "Sistema de frenos en buen estado",
    "Taxímetro instalado, calibrado y sellado",
    "Copia del contrato de compraventa entregada",
    "Copia del pagaré entregada",
    "Fondo de garantía depositado y verificado",
    "Kilómetros del odómetro al momento de entrega: ____________",
  ];

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  for (const item of checkItems) {
    checkPage(doc, cur, 5);
    doc.text(`☐  ${item}`, MARGIN_L, cur.y);
    cur.y += 4.5;
  }

  cur.y += 5;
  addParagraph(doc, cur, "Observaciones: ________________________________________________");
  addParagraph(doc, cur, "________________________________________________________________");

  addParagraph(doc, cur,
    "Ambas partes declaran estar conformes con el estado del vehículo al momento de la entrega y firman la presente acta como constancia."
  );

  addSignatureBlock(doc, cur, [
    { label: "RECIBE (EL COMPRADOR)", name: nombre },
    { label: "ENTREGA (EL VENDEDOR)", name: EMPRESA.representante },
  ]);

  addFooter(doc, orig.folio);
  return doc.output("blob");
}
