import PDFDocument from "pdfkit";
import type { Origination, Taxista, VehicleInventory } from "@shared/schema";

// ===== CONSTANTS =====
const EMPRESA = {
  nombre: "CONDUCTORES DEL MUNDO, S.A.P.I. DE C.V.",
  rfc: "CMU201119DD6",
  domicilio: "Lago de Chapultepec 6-40, Cañadas del Lago, Corregidora, Querétaro",
  ciudad: "Aguascalientes, Ags.",
  representante: "Representante CMU", // Updated from team-config at runtime if needed
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

// ===== PDF STYLES =====
function addHeader(doc: InstanceType<typeof PDFDocument>, title: string, folio: string) {
  doc.fontSize(14).font("Helvetica-Bold").text(EMPRESA.nombre, { align: "center" });
  doc.moveDown(0.3);
  doc.fontSize(10).font("Helvetica").text(`RFC: ${EMPRESA.rfc}`, { align: "center" });
  doc.moveDown(0.3);
  doc.fontSize(8).text(EMPRESA.domicilio, { align: "center" });
  doc.moveDown(0.8);

  // Title
  doc.fontSize(12).font("Helvetica-Bold").text(title, { align: "center", underline: true });
  doc.moveDown(0.3);
  doc.fontSize(9).font("Helvetica").text(`Folio: ${folio}`, { align: "center" });
  doc.moveDown(1);
}

function addClause(doc: InstanceType<typeof PDFDocument>, number: string, title: string, body: string) {
  doc.fontSize(10).font("Helvetica-Bold").text(`${number}. ${title}`, { continued: false });
  doc.moveDown(0.3);
  doc.fontSize(9).font("Helvetica").text(body, { align: "justify", lineGap: 2 });
  doc.moveDown(0.6);
}

function addSignatureBlock(doc: InstanceType<typeof PDFDocument>, names: { label: string; name: string }[]) {
  doc.moveDown(2);
  doc.fontSize(9).font("Helvetica").text("Firmas:", { underline: true });
  doc.moveDown(1.5);

  const startX = doc.x;
  const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / names.length;

  names.forEach((n, i) => {
    const x = startX + (i * colWidth);
    doc.fontSize(8).font("Helvetica")
      .text("_____________________________", x, doc.y, { width: colWidth, align: "center" })
      .text(n.name, x, doc.y + 2, { width: colWidth, align: "center" })
      .text(n.label, x, doc.y + 2, { width: colWidth, align: "center" });
  });
}

function addFooter(doc: InstanceType<typeof PDFDocument>, folio: string) {
  const y = doc.page.height - 40;
  doc.fontSize(7).font("Helvetica").fillColor("#999999")
    .text(`${folio} — Generado el ${fmtDate(new Date().toISOString())} — ${EMPRESA.nombre}`, 
      doc.page.margins.left, y, { align: "center", width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
  doc.fillColor("#000000");
}

// ===== CONVENIO DE VALIDACIÓN =====
export function generateConvenioValidacion(
  orig: Origination,
  taxista: Taxista | null,
  vehicle: VehicleInventory | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 50, bottom: 50, left: 60, right: 60 } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

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

    // PAGE 1: Convenio
    addHeader(doc, "CONVENIO DE VALIDACIÓN", orig.folio);

    doc.fontSize(9).font("Helvetica").text(
      `En la ciudad de ${EMPRESA.ciudad}, a ${fmtDate(new Date().toISOString())}, celebran el presente Convenio de Validación, por una parte ${EMPRESA.nombre} (en adelante "CMU"), representada por ${EMPRESA.representante}, y por la otra ${nombre} (en adelante "EL OPERADOR").`,
      { align: "justify", lineGap: 2 }
    );
    doc.moveDown(0.8);

    addClause(doc, "PRIMERA", "OBJETO",
      `El presente convenio tiene como objeto establecer los términos y condiciones bajo los cuales CMU validará la idoneidad de EL OPERADOR para participar en el programa de adquisición de vehículos siniestrados rehabilitados, así como las obligaciones derivadas del período de validación.`
    );

    addClause(doc, "SEGUNDA", "DATOS DEL OPERADOR",
      `Nombre completo: ${nombre}\nCURP: ${curp}\nRFC: ${rfc}\nTeléfono: ${telefono}\nDomicilio: ${domicilio}\nNúmero de concesión: ${concesion}\nPerfil de consumo: ${orig.perfilTipo === "A" ? "A (GNV, ≥400 LEQ/mes)" : "B (Gasolina, tickets ≥$6,000/mes)"}`
    );

    addClause(doc, "TERCERA", "VEHÍCULO EN VALIDACIÓN",
      `Marca: ${vMarca}\nModelo: ${vModelo}\nAño: ${vAnio}\nNúmero de serie: ${vSerie}\n\nEl vehículo descrito será entregado a EL OPERADOR en calidad de comodato durante el período de validación, el cual no excederá de 30 (treinta) días naturales contados a partir de la firma del presente convenio.`
    );

    addClause(doc, "CUARTA", "OBLIGACIONES DEL OPERADOR DURANTE LA VALIDACIÓN",
      `EL OPERADOR se obliga a:\na) Utilizar el vehículo exclusivamente para servicio de transporte público (taxi) en la ciudad de Aguascalientes.\nb) Mantener el vehículo en buen estado de conservación y limpieza.\nc) Cubrir los gastos de combustible y peajes durante el período de validación.\nd) Reportar de inmediato cualquier incidente, accidente o falla mecánica.\ne) No prestar, subarrendar ni transferir el uso del vehículo a terceros.\nf) Devolver el vehículo al término del período de validación en las mismas condiciones en que fue recibido, salvo el desgaste normal por uso.`
    );

    addClause(doc, "QUINTA", "FONDO DE GARANTÍA",
      `EL OPERADOR acepta depositar un fondo de garantía inicial de ${fmtMoney(PLAZOS.fondoInicial)} previo a la entrega del vehículo, en la cuenta bancaria de CMU con CLABE ${BANCREA_CLABE} (Bancrea). Este fondo será aplicado como parte del anticipo en caso de formalizar la compraventa a plazos, o devuelto íntegramente en caso de no continuar con el programa.`
    );

    addClause(doc, "SEXTA", "EVALUACIÓN Y RESULTADO",
      `Al término del período de validación, CMU evaluará el desempeño de EL OPERADOR con base en:\na) Cumplimiento del perfil de consumo mínimo establecido.\nb) Estado general del vehículo.\nc) Cumplimiento de las obligaciones descritas en la cláusula CUARTA.\n\nCon base en esta evaluación, CMU emitirá un dictamen de "APROBADO" o "NO APROBADO" para proceder a la formalización del Contrato de Compraventa a Plazos.`
    );

    addClause(doc, "SÉPTIMA", "TERMINACIÓN ANTICIPADA",
      `Cualquiera de las partes podrá dar por terminado el presente convenio en cualquier momento, notificando por escrito a la otra parte con al menos 5 (cinco) días de anticipación. En caso de terminación anticipada, EL OPERADOR se obliga a devolver el vehículo dentro de las 48 horas siguientes a la notificación.`
    );

    addClause(doc, "OCTAVA", "JURISDICCIÓN",
      `Para la interpretación y cumplimiento del presente convenio, las partes se someten a la jurisdicción de los tribunales competentes de la ciudad de Aguascalientes, Ags., renunciando a cualquier otro fuero que por razón de domicilio presente o futuro pudiera corresponderles.`
    );

    doc.moveDown(0.5);
    doc.fontSize(9).font("Helvetica").text(
      "Leído que fue el presente convenio y enteradas las partes de su contenido y alcance legal, lo firman por duplicado en la fecha indicada.",
      { align: "justify" }
    );

    addSignatureBlock(doc, [
      { label: "EL OPERADOR", name: nombre },
      { label: "CMU", name: EMPRESA.representante },
    ]);

    addFooter(doc, orig.folio);
    doc.end();
  });
}

// ===== CONTRATO DE COMPRAVENTA A PLAZOS =====
export function generateContratoCompraventa(
  orig: Origination,
  taxista: Taxista | null,
  vehicle: VehicleInventory | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 50, bottom: 50, left: 60, right: 60 } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const nombre = taxista
      ? `${taxista.nombre} ${taxista.apellidoPaterno} ${taxista.apellidoMaterno || ""}`.trim()
      : fullName(orig.datosIne);
    const curp = taxista?.curp || safeGet(orig.datosIne, "curp");
    const rfc = taxista?.rfc || safeGet(orig.datosCsf, "rfc");
    const telefono = taxista?.telefono || orig.otpPhone || "____________";
    const domicilio = taxista?.direccion || safeGet(orig.datosComprobante, "direccion");
    const concesion = safeGet(orig.datosConcesion, "numero_concesion");
    const clabe = taxista?.clabe || safeGet(orig.datosEstadoCuenta, "clabe");
    const banco = taxista?.banco || safeGet(orig.datosEstadoCuenta, "banco");

    const vMarca = vehicle?.marca || safeGet(orig.datosFactura, "marca");
    const vModelo = vehicle?.modelo || safeGet(orig.datosFactura, "modelo");
    const vAnio = vehicle?.anio?.toString() || safeGet(orig.datosFactura, "anio");
    const vSerie = vehicle?.numSerie || safeGet(orig.datosFactura, "num_serie");
    const vNiv = vehicle?.niv || safeGet(orig.datosFactura, "niv");
    const vMotor = vehicle?.numMotor || "____________";
    const vColor = vehicle?.color || "____________";

    // Calculate financial terms
    const cmuVal = vehicle?.cmuValor || 200000;
    const ventaPlazos = Math.round(cmuVal * PLAZOS.markup);
    const montoFinanciar = ventaPlazos - PLAZOS.anticipo;
    const tasaMensual = PLAZOS.tasaAnual / 12;
    const mensualidad = Math.round(montoFinanciar * (tasaMensual * Math.pow(1 + tasaMensual, PLAZOS.meses)) / (Math.pow(1 + tasaMensual, PLAZOS.meses) - 1));
    const totalPagar = PLAZOS.anticipo + (mensualidad * PLAZOS.meses);

    // PAGE 1: Contrato
    addHeader(doc, "CONTRATO DE COMPRAVENTA A PLAZOS", orig.folio);

    doc.fontSize(9).font("Helvetica").text(
      `En la ciudad de ${EMPRESA.ciudad}, a ${fmtDate(new Date().toISOString())}, celebran el presente Contrato de Compraventa a Plazos, por una parte ${EMPRESA.nombre} (en adelante "EL VENDEDOR"), con domicilio en ${EMPRESA.domicilio}, representada por ${EMPRESA.representante}, y por la otra ${nombre} (en adelante "EL COMPRADOR").`,
      { align: "justify", lineGap: 2 }
    );
    doc.moveDown(0.8);

    // DECLARATIONS
    doc.fontSize(11).font("Helvetica-Bold").text("DECLARACIONES", { underline: true });
    doc.moveDown(0.5);

    doc.fontSize(9).font("Helvetica-Bold").text("I. Declara EL VENDEDOR que:");
    doc.fontSize(9).font("Helvetica").text(
      `a) Es una Sociedad Anónima Promotora de Inversión de Capital Variable, constituida conforme a las leyes mexicanas, con RFC ${EMPRESA.rfc}.\nb) Es legítimo propietario del vehículo objeto de este contrato.\nc) El vehículo se encuentra libre de todo gravamen, embargo o limitación de dominio.\nd) Cuenta con las facultades necesarias para celebrar el presente contrato.`,
      { align: "justify", lineGap: 2 }
    );
    doc.moveDown(0.5);

    doc.fontSize(9).font("Helvetica-Bold").text("II. Declara EL COMPRADOR que:");
    doc.fontSize(9).font("Helvetica").text(
      `a) Se identifica con el nombre de ${nombre}, con CURP ${curp} y RFC ${rfc}.\nb) Tiene su domicilio en ${domicilio}.\nc) Es titular de la concesión de taxi número ${concesion} en el municipio de Aguascalientes.\nd) Ha sido informado sobre las condiciones del vehículo, su origen como vehículo siniestrado rehabilitado, y acepta adquirirlo en el estado en que se encuentra.\ne) Cuenta con la capacidad legal y económica para cumplir con las obligaciones derivadas del presente contrato.`,
      { align: "justify", lineGap: 2 }
    );
    doc.moveDown(0.8);

    // CLÁUSULAS
    doc.fontSize(11).font("Helvetica-Bold").text("CLÁUSULAS", { underline: true });
    doc.moveDown(0.5);

    addClause(doc, "PRIMERA", "OBJETO",
      `EL VENDEDOR transmite en favor de EL COMPRADOR la propiedad del vehículo descrito en la cláusula SEGUNDA, sujeto a las condiciones de pago a plazos establecidas en el presente contrato. La propiedad plena se transferirá una vez liquidado el 100% del precio pactado.`
    );

    addClause(doc, "SEGUNDA", "DESCRIPCIÓN DEL VEHÍCULO",
      `Marca: ${vMarca}\nModelo: ${vModelo}\nAño: ${vAnio}\nColor: ${vColor}\nNúmero de serie (NIV): ${vNiv}\nNúmero de motor: ${vMotor}\n\nEL COMPRADOR declara haber inspeccionado el vehículo y estar conforme con su estado actual.`
    );

    addClause(doc, "TERCERA", "PRECIO Y CONDICIONES DE PAGO",
      `El precio total de venta del vehículo es de ${fmtMoney(ventaPlazos)} (${numberToWords(ventaPlazos)} pesos 00/100 M.N.), que se pagará de la siguiente forma:\n\na) Anticipo: ${fmtMoney(PLAZOS.anticipo)}, pagadero en el mes ${PLAZOS.mesAnticipo} contado a partir de la fecha de entrega del vehículo.\nb) Saldo a financiar: ${fmtMoney(montoFinanciar)}\nc) Plazo: ${PLAZOS.meses} mensualidades\nd) Tasa de interés anual: ${(PLAZOS.tasaAnual * 100).toFixed(1)}%\ne) Mensualidad fija: ${fmtMoney(mensualidad)}\nf) Total a pagar (anticipo + mensualidades): ${fmtMoney(totalPagar)}\n\nLos pagos deberán realizarse mediante depósito o transferencia a la cuenta CLABE ${BANCREA_CLABE} (Bancrea) a nombre de ${EMPRESA.nombre}, a más tardar el día 5 de cada mes.`
    );

    addClause(doc, "CUARTA", "PROGRAMA DE RECAUDO GNV",
      `${orig.perfilTipo === "A" ? 
        `EL COMPRADOR se compromete a participar en el programa de recaudo de Gas Natural Vehicular (GNV), mediante el cual CMU retendrá ${fmtMoney(PLAZOS.gnvRevenue)} mensuales del consumo de GNV de EL COMPRADOR como parte del esquema de pago. Este monto se aplicará directamente a la mensualidad correspondiente.` :
        `EL COMPRADOR, al ser perfil de consumo B (gasolina), no participará en el programa de recaudo GNV. Las mensualidades deberán cubrirse íntegramente mediante depósito o transferencia bancaria.`
      }`
    );

    addClause(doc, "QUINTA", "FONDO DE GARANTÍA",
      `EL COMPRADOR acepta la constitución de un fondo de garantía de ${fmtMoney(PLAZOS.fondoInicial)} inicial, más aportaciones mensuales de ${fmtMoney(PLAZOS.fondoMensual)} que serán adicionadas a cada mensualidad. El fondo de garantía será devuelto a EL COMPRADOR al momento de liquidar la totalidad del precio de venta, siempre que no existan adeudos pendientes o daños al vehículo que requieran compensación.`
    );

    addClause(doc, "SEXTA", "RESERVA DE DOMINIO",
      `Ambas partes convienen que EL VENDEDOR se reserva el dominio del vehículo hasta que EL COMPRADOR haya cubierto la totalidad del precio pactado. Durante la vigencia de esta reserva, EL COMPRADOR no podrá enajenar, gravar ni disponer del vehículo sin autorización expresa y por escrito de EL VENDEDOR.`
    );

    addClause(doc, "SÉPTIMA", "OBLIGACIONES DEL COMPRADOR",
      `EL COMPRADOR se obliga a:\na) Realizar los pagos en tiempo y forma.\nb) Utilizar el vehículo exclusivamente como taxi en la ciudad de Aguascalientes.\nc) Mantener el vehículo en buen estado de conservación.\nd) Contratar y mantener vigente un seguro de responsabilidad civil.\ne) No modificar las características del vehículo sin autorización de EL VENDEDOR.\nf) Permitir la inspección del vehículo por parte de EL VENDEDOR cuando este lo solicite.\ng) Notificar de inmediato cualquier siniestro, robo o daño al vehículo.`
    );

    addClause(doc, "OCTAVA", "CAUSAS DE RESCISIÓN",
      `EL VENDEDOR podrá dar por rescindido el presente contrato sin necesidad de declaración judicial cuando:\na) EL COMPRADOR incurra en mora de 2 (dos) o más mensualidades consecutivas.\nb) EL COMPRADOR destine el vehículo a un uso distinto al pactado.\nc) EL COMPRADOR enajene, grave o transfiera el vehículo sin autorización.\nd) Se presente cualquier otra causa que a juicio de EL VENDEDOR ponga en riesgo la recuperación del crédito.\n\nEn caso de rescisión, EL COMPRADOR deberá devolver el vehículo dentro de las 48 horas siguientes a la notificación. Los pagos realizados serán aplicados a una renta proporcional por el uso del vehículo.`
    );

    addClause(doc, "NOVENA", "GASTOS Y CONTRIBUCIONES",
      `Serán por cuenta de EL COMPRADOR todos los gastos de mantenimiento, combustible, verificación vehicular, tenencia, derechos de placa y cualquier otra contribución o gasto derivado del uso y posesión del vehículo durante la vigencia del presente contrato.`
    );

    addClause(doc, "DÉCIMA", "JURISDICCIÓN Y LEGISLACIÓN APLICABLE",
      `Para la interpretación, cumplimiento y ejecución del presente contrato, las partes se someten expresamente a la jurisdicción de los tribunales competentes de la ciudad de Aguascalientes, estado de Aguascalientes, renunciando a cualquier otro fuero que por razón de domicilio presente o futuro pudiera corresponderles. En lo no previsto por este contrato, se aplicarán las disposiciones del Código Civil y Código de Comercio vigentes.`
    );

    doc.moveDown(0.5);
    doc.fontSize(9).font("Helvetica").text(
      "Leído que fue el presente contrato y enteradas las partes de su contenido y alcance legal, lo firman por duplicado en la fecha y lugar indicados.",
      { align: "justify" }
    );

    addSignatureBlock(doc, [
      { label: "EL COMPRADOR", name: nombre },
      { label: "EL VENDEDOR", name: EMPRESA.representante },
    ]);

    addFooter(doc, orig.folio);

    // PAGE 2: PAGARÉ
    doc.addPage();
    addHeader(doc, "PAGARÉ", `${orig.folio}-PAG`);

    doc.fontSize(9).font("Helvetica").text(
      `Bueno por: ${fmtMoney(totalPagar)}`,
      { align: "right" }
    );
    doc.moveDown(0.5);

    doc.fontSize(9).font("Helvetica").text(
      `En la ciudad de ${EMPRESA.ciudad}, a ${fmtDate(new Date().toISOString())}, debo y pagaré incondicionalmente a la orden de ${EMPRESA.nombre}, con domicilio en ${EMPRESA.domicilio}, la cantidad de ${fmtMoney(totalPagar)} (${numberToWords(totalPagar)} pesos 00/100 M.N.), valor recibido a mi entera satisfacción por la compra del vehículo ${vMarca} ${vModelo} ${vAnio}, serie ${vSerie}.`,
      { align: "justify", lineGap: 2 }
    );
    doc.moveDown(0.5);

    doc.fontSize(9).font("Helvetica").text(
      `Este pagaré será liquidado en ${PLAZOS.meses} pagos mensuales consecutivos de ${fmtMoney(mensualidad)} cada uno, más un anticipo de ${fmtMoney(PLAZOS.anticipo)} en el mes ${PLAZOS.mesAnticipo}, comenzando a partir del mes siguiente a la firma del presente documento.`,
      { align: "justify", lineGap: 2 }
    );
    doc.moveDown(0.5);

    doc.fontSize(9).font("Helvetica").text(
      `En caso de falta de pago oportuno, el saldo insoluto causará intereses moratorios a razón del ${((PLAZOS.tasaAnual * 1.5) * 100).toFixed(1)}% anual, sin perjuicio de las demás acciones legales que correspondan.`,
      { align: "justify", lineGap: 2 }
    );
    doc.moveDown(0.5);

    doc.fontSize(9).font("Helvetica").text(
      `Suscriptor:\nNombre: ${nombre}\nCURP: ${curp}\nDomicilio: ${domicilio}\nTeléfono: ${telefono}`,
      { lineGap: 2 }
    );

    doc.moveDown(2);
    doc.fontSize(9).text("_____________________________", { align: "center" });
    doc.fontSize(8).text(nombre, { align: "center" });
    doc.text("Firma del suscriptor", { align: "center" });

    addFooter(doc, orig.folio);

    // PAGE 3: CHECKLIST DE ENTREGA
    doc.addPage();
    addHeader(doc, "CHECKLIST DE ENTREGA DE VEHÍCULO", orig.folio);

    doc.fontSize(9).font("Helvetica").text(`Fecha de entrega: ${fmtDate(new Date().toISOString())}`);
    doc.moveDown(0.3);
    doc.text(`Entrega a: ${nombre}`);
    doc.text(`Vehículo: ${vMarca} ${vModelo} ${vAnio} — Serie: ${vSerie}`);
    doc.moveDown(0.8);

    const checkItems = [
      "Vehículo en condiciones de operación",
      "Llaves entregadas (juego principal + copia)",
      "Tarjeta de circulación vigente",
      "Póliza de seguro RC vigente",
      "Kit de herramienta básica (gato, llave de cruz, triángulos)",
      "Llanta de refacción en buen estado",
      "Verificación vehicular vigente",
      "Calcomanía de GNV (si aplica)",
      "Sistema de GNV funcionando correctamente (si aplica)",
      "Tanque de GNV con vigencia de prueba hidrostática",
      "Luces y señalización funcionando",
      "Frenos en buen estado",
      "Taxímetro instalado y calibrado",
      "Copia del contrato entregada al comprador",
      "Fondo de garantía depositado y verificado",
    ];

    checkItems.forEach((item) => {
      doc.fontSize(9).font("Helvetica").text(`☐  ${item}`);
      doc.moveDown(0.2);
    });

    doc.moveDown(1);
    doc.fontSize(9).font("Helvetica").text("Observaciones: ________________________________________________");
    doc.moveDown(0.3);
    doc.text("________________________________________________________________");
    doc.moveDown(0.3);
    doc.text("________________________________________________________________");

    doc.moveDown(1.5);

    addSignatureBlock(doc, [
      { label: "RECIBE", name: nombre },
      { label: "ENTREGA", name: EMPRESA.representante },
    ]);

    addFooter(doc, orig.folio);
    doc.end();
  });
}

// Simple number-to-words for Mexican legal documents
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
  if (n >= 1000000) {
    const m = Math.floor(n / 1000000);
    n = n % 1000000;
    parts.push(m === 1 ? "un millón" : `${chunk(m)} millones`);
  }
  if (n >= 1000) {
    const k = Math.floor(n / 1000);
    n = n % 1000;
    parts.push(k === 1 ? "mil" : `${chunk(k)} mil`);
  }
  if (n > 0) {
    parts.push(chunk(n));
  }
  return parts.join(" ") || "cero";
}
