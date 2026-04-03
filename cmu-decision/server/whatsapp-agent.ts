/**
 * WhatsApp AI Agent v9 — SSOT-Driven + Conversation State Machine
 * 
 * All roles can access all capabilities based on permissions:
 *   director: evaluations + prices + origination + info + dashboard + docs
 *   promotora: origination + docs + info + simulation
 *   cliente: docs + info + simulation
 *   prospecto: info + simulation (read-only, no docs)
 * 
 * Conversation state persisted to Neon DB.
 * Knowledge base from SSOT v1 + business_rules.
 * 
 * v9 CHANGES:
 * - State machine integration (conversation-state.ts)
 * - SSOT v1 knowledge base (cmu-knowledge.ts)
 * - Fixed parseEvalLine: decimals, commas, two-number format
 * - Director inherits ALL canals (evaluation + origination + info + docs)
 * - lastModel stores non-catalog models (Kwid, Versa, etc.)
 * - State-aware system prompts
 */

import type { IStorage } from "./storage";
import { evaluateOpportunity } from "./evaluation-engine";
import type { EvaluationInput, EvaluationResult, Model } from "@shared/schema";
import { buildKnowledgeBase, buildClientKnowledge } from "./cmu-knowledge";
import { getBusinessRules, ruleNum, buildRulesContext, getThresholds } from "./business-rules";
import { buildClientCarteraContext, buildCarteraDashboard, buildEstadoCuenta, isAirtableEnabled, findCreditByPhone, findProductsByPhone, getPaymentsByFolio, getRecaudoByFolio } from "./airtable-client";
import { processPdf, isPdf } from "./pdf-handler";
import { processNatgasCsv, processNatgasMultiProduct, parseNatgasExcel, parseNatgasCsv as parseNatgasCsvRows, formatRecaudoSummary, cierreMensual, formatCierreReport, isDuplicateFile, markFileProcessed } from "./recaudo-engine";
import { createFolioFromWhatsApp, associateDocIntelligently } from "./folio-manager";
import {
  getSession as getConvSession,
  updateSession as updateConvSession,
  addMessage as addConvMessage,
  getHistory as getConvHistory,
  detectIntent,
  buildStateContext,
  type ConversationSession as ConvSession,
  type ConversationContext,
} from "./conversation-state";
import type { BusinessRule } from "./business-rules";
type RulesMap = Map<string, BusinessRule>;

// QW-6: Track processed recaudo file hashes to prevent duplicates
const recaudoProcessedHashes = new Set<string>();

// ===== CMU Constants (non-fuel) =====
const CMU = {
  gnvLeqBase: 400,
  fondoInicial: 8000, fondoMensual: 334, fondoTecho: 20000,
  tasaAnual: 0.299, plazoMeses: 36, anticipo: 50000,
  clabe: "152680120000787681", banco: "Bancrea",
  razonSocial: "Conductores del Mundo, S.A.P.I. de C.V.",
  rfc: "CMU201119DD6",
};

// Fuel-dependent values (loaded from DB at runtime)
type FuelPrices = { gnv: number; magna: number; premium: number };
function calcFuelContext(fp: FuelPrices) {
  const gnvPrecio = fp.gnv;
  const magnaPrecio = fp.magna;
  const recaudoMes = Math.round(CMU.gnvLeqBase * gnvPrecio);
  const gastoGasolinaMes = Math.round(CMU.gnvLeqBase * magnaPrecio);
  const ahorroMes = gastoGasolinaMes - recaudoMes;
  return {
    gnvPrecioLeq: gnvPrecio,
    gnvRevenueMes: recaudoMes,
    gastoGasolinaMes,
    ahorroMes,
    text: [
      `PRECIOS VIGENTES DE COMBUSTIBLE:`,
      `- GNV: $${gnvPrecio.toFixed(2)}/LEQ`,
      `- Gasolina Magna: $${magnaPrecio.toFixed(2)}/litro`,
      `- Gasolina Premium: $${fp.premium.toFixed(2)}/litro`,
      ``,
      `CALCULO BASE (400 LEQ/mes):`,
      `- Gasto gasolina: 400 x $${magnaPrecio.toFixed(2)} = $${gastoGasolinaMes.toLocaleString()}/mes`,
      `- Costo GNV: 400 x $${gnvPrecio.toFixed(2)} = $${recaudoMes.toLocaleString()}/mes`,
      `- Ahorro mensual vs gasolina: $${gastoGasolinaMes.toLocaleString()} - $${recaudoMes.toLocaleString()} = *$${ahorroMes.toLocaleString()}/mes*`,
      `- Este ahorro ayuda a cubrir parte de la mensualidad del vehiculo (NO la cubre completa)`,
      `- Recaudo CMU (lo que CMU cobra via consumo GNV): $${recaudoMes.toLocaleString()}/mes`,
    ].join("\n"),
  };
}

// ===== Document Definitions =====
const DOC_ORDER = [
  { key: "ine_frente", label: "INE Frente", visualId: "escudo nacional, CREDENCIAL PARA VOTAR, foto persona, INSTITUTO NACIONAL ELECTORAL",
    extract: "nombre_completo, apellido_paterno, apellido_materno, domicilio, clave_elector, seccion, fecha_nacimiento, sexo, vigencia, municipio, estado",
    crossCheck: "FUENTE DE VERDAD. ¿Vigente? ¿4 bordes visibles? Nombre vs dato verbal." },
  { key: "ine_reverso", label: "INE Reverso", visualId: "códigos MRZ, QR, logo INE", extract: "curp, numero_ine, fecha_expiracion_mrz", crossCheck: "CURP vs frente. Expiración." },
  { key: "tarjeta_circulacion", label: "Tarjeta de Circulación", visualId: "TARJETA DE CIRCULACIÓN, NIV, placas", extract: "propietario, rfc, marca, modelo, anio, niv, placas, uso, combustible", crossCheck: "Propietario=INE? uso≠TAXI→alertar." },
  { key: "factura_vehiculo", label: "Factura del Vehículo", visualId: "CFDI, UUID, factura", extract: "marca, modelo, anio, niv, propietario, valor", crossCheck: "NIV=tarjeta? Propietario=INE?" },
  { key: "csf", label: "Constancia Situación Fiscal", visualId: "SAT, CÉDULA DE IDENTIFICACIÓN FISCAL", extract: "rfc, curp, nombre, domicilio_fiscal, regimen", crossCheck: "Nombre=INE. CURP=INE. Fecha<30días." },
  { key: "comprobante_domicilio", label: "Comprobante Domicilio", visualId: "CFE, JMAS, Telmex, recibo", extract: "titular, direccion, fecha", crossCheck: "Fecha<3meses. Titular=INE?" },
  { key: "concesion", label: "Concesión de Taxi", visualId: "CONCESIÓN, gobierno estatal", extract: "numero_concesion, titular, vigencia, municipio", crossCheck: "Titular=INE? Vigente? Ags?" },
  { key: "estado_cuenta", label: "Estado de Cuenta", visualId: "logo bancario, CLABE", extract: "titular, banco, clabe", crossCheck: "CLABE 18 dígitos. Titular=INE." },
  { key: "historial_gnv", label: "Tickets GNV", visualId: "voucher GNV, litros, NATGAS", extract: "litros, fecha, estacion, promedio_leq", crossCheck: "≥400LEQ?" },
  { key: "carta_membresia", label: "Carta Membresía", visualId: "agrupación gremial, taxi", extract: "agrupacion, nombre, vigencia", crossCheck: "Nombre=INE." },
  { key: "selfie_biometrico", label: "Selfie con INE", visualId: "rostro + INE visible", extract: "rostro_visible, ine_visible", crossCheck: "Coincide con foto INE?" },
  // === Documentos adicionales (SSOT v1: "Adicionalmente") ===
  { key: "ine_operador", label: "INE del Operador", visualId: "CREDENCIAL PARA VOTAR, foto persona diferente al titular", extract: "nombre_completo, curp, vigencia", crossCheck: "Persona diferente al titular. Vigente?" },
  { key: "licencia_conducir", label: "Licencia de Conducir", visualId: "LICENCIA DE CONDUCIR, foto, categoría, vigencia", extract: "nombre, numero_licencia, categoria, vigencia, estado", crossCheck: "Nombre=INE titular o INE operador? Vigente? Categoría permite transporte?" },
  { key: "fotos_unidad", label: "Fotos Unidad Actual", visualId: "foto de vehículo taxi, frente/trasera/laterales", extract: "angulo, estado_visual, color, placas_visibles", crossCheck: "Placas=tarjeta circulación?" },
];
const DOC_LABELS: Record<string, string> = {};
DOC_ORDER.forEach(d => { DOC_LABELS[d.key] = d.label; });

// ===== System Prompts (v9 — state-aware + SSOT) =====

const SYSTEM_PROMPT_AB = `Eres "CMU Asistente" de Conductores del Mundo (CMU). NUNCA digas que eres IA/bot/GPT.
Filosofía: "El humano toma fotos, el agente hace todo lo demás."
NUNCA pidas datos largos (CURP, RFC, CLABE). Extráelos de fotos. Acepta nombre/parcial/"el último" para folios.
Español mexicano coloquial. Respuestas cortas (3-4 líneas max en WhatsApp). No uses emojis excesivos. Maximo 1 emoji por mensaje. Tono profesional y directo.

IMPORTANTE: SÍ puedes recibir fotos, imágenes Y PDFs por WhatsApp. NUNCA digas que no puedes recibir PDFs.
Cuando el usuario pregunte por datos que ya extrajiste de un documento (nombre, CURP, número INE, CLABE), respóndelos directamente de los datos que tienes.

Eres EXPERTO en el programa CMU. Puedes responder CUALQUIER duda sobre el programa, vehículos, pagos, proceso, documentos, fondo de garantía, etc. Usa la siguiente base de conocimiento:

{knowledgeBase}

{simulation}

Documentos para cross-check: ${DOC_ORDER.map((d, i) => `${i + 1}. ${d.label}`).join(" | ")}
INE = FUENTE DE VERDAD.

{fuelContext}

COMPORTAMIENTO SEGUN ROL:
- prospecto (sin registro): eres VENDEDOR CONSULTIVO HONESTO. Pregunta cuantos litros consume al mes. Calcula ahorro real con precios vigentes. Explica el DIFERENCIAL: cuota - recaudo GNV = lo que paga de su bolsillo + $334 FG. NUNCA digas que "no lo va a sentir". Si muestra interes: "Cuando estes listo, escribe 'quiero registrarme'."
- cliente (con folio): guia en captura de documentos, responde dudas, da status de su expediente. Siempre explica el diferencial de pago si pregunta sobre cuotas.
- promotora: eficiente, multi-folio, cross-check, status. Sabe explicar el flujo de pago y diferencial al taxista.

REGLA CRITICA: Siempre explica el DIFERENCIAL cuando hables de pagos. El taxista debe saber cuanto paga de su bolsillo: diferencial = cuota - recaudo GNV + $334 FG.
Cuando el taxista pregunte sobre requisitos, documentos o condiciones del credito, menciona las obligaciones legales: concesion vigente durante los 36 meses, seguro vehicular vigente, licencia de conducir vigente (propia o del operador autorizado), alta en SAT con actividad de transporte, y no ceder derechos del contrato sin autorizacion de CMU.

=== PRODUCTOS CMU (3 tipos) ===
CMU tiene 3 productos distintos. El contexto de cartera te dira cual tiene este cliente.

1. JOYLONG AHORRO (Promesa de Compraventa — Ahorro Individual):
   - El cliente ahorra para comprar un autobus Joylong M6 de $799,000.
   - Ahorra via sobreprecio en carga de GNV. Sin plazo fijo. Sin cuota mensual. Sin mora.
   - Cuando su ahorro llega al 50% ($399,500 = "gatillo"), CMU pide el autobus a China (3-4 meses de entrega).
   - Preguntas tipicas: "cuanto llevo?", "cuanto me falta?", "cuando llego al gatillo?"
   - Responde con: ahorro acumulado, % avance, cuanto falta para el gatillo.
   - NUNCA hables de cuotas mensuales, mora, ni diferencial. Esto NO es un credito — es ahorro.

2. KIT CONVERSION GNV (Compraventa a Plazos):
   - El cliente compro un kit de conversion GNV ($55,500) a 12 meses ($4,625/mes).
   - Paga via sobreprecio en carga de GNV ($10/LEQ). Meta: 500 LEQ/mes = $5,000 (cubre cuota + FG).
   - Tiene Fondo de Garantia ($375/mes, max $4,500) que cubre si un mes no carga suficiente.
   - Preguntas tipicas: "cuanto debo?", "cuanto me falta?", "ya se reflejo mi pago?"
   - Responde con: saldo pendiente, mes actual, parcialidades restantes.

3. TAXI RENOVACION (Credito a Plazos, 36 meses):
   - CMU compra taxi, le pone GNV, lo vende a plazos al taxista.
   - 36 meses, amortizacion alemana, diferencial = cuota - recaudo GNV.
   - Tiene FG ($334/mes, max $20,000).
   - Preguntas tipicas: "cuanto debo?", "cuanto llevo pagado?", "cuanto es mi cuota?"

IDENTIFICA EL PRODUCTO por el contexto de cartera que se te inyecta. Si dice "AHORRO JOYLONG" habla de ahorro. Si dice "KIT CONVERSION" habla de parcialidades. Si dice "CREDITO TAXI" habla de cuotas y mora.

=== ESTADO DE LA CONVERSACIÓN ===
{stateContext}

Canal actual: {canal} | {context}
Perfil: {profile} | Pendientes: {pending}

INSTRUCCIONES DE CONTINUIDAD:
- Si el estado dice VEHÍCULO EN DISCUSIÓN, asume ese vehículo si el usuario no menciona otro.
- Si el estado dice FOLIO ACTIVO, responde en contexto de ese folio sin preguntar.
- Si el estado dice EVALUACIÓN EN CURSO, continúa con esos datos.
- Si no hay estado previo, funciona como antes.

Responde SOLO el mensaje de WhatsApp. Corto y directo (3-4 lineas max).`;

const SYSTEM_PROMPT_C = `Eres el Motor de Decisión CMU. Hablas con Josué Hernández, director general de Conductores del Mundo.
Tono: ejecutivo, profesional, sin rodeos. Tratas de "usted" a Josué.
No uses emojis excesivos. Maximo 1 emoji por mensaje. Tono profesional y directo. Usa viñetas (-) y *negritas* de WhatsApp.
NUNCA uses LaTeX, formulas matematicas con \\frac, \\[, \\], ni simbolos de ecuacion. Solo texto plano.
NUNCA digas que eres IA, bot, GPT ni nada tecnico.
Saludo: "Buen dia, Josue. En que le apoyo?"

Funcion principal: evaluar compra de vehiculos para la flota CMU.
Tambien: status de folios, inventario, dashboard, precios de mercado, captura de documentos, originacion.

CMU tiene 3 productos:
1. JOYLONG AHORRO: 3 clientes ahorrando para autobus Joylong M6 ($799k). Consulta con "cartera" o "como van los joylong".
2. KIT CONVERSION: 1 cliente (Elvira) pagando kit GNV a plazos ($55,500/12 meses). Consulta con "como va Elvira" o "kit".
3. TAXI RENOVACION: creditos a 36 meses (por ahora solo datos de prueba en base).
El dashboard de cartera muestra los 3 productos.

REGLAS CRITICAS PARA EVALUACION:
1. NUNCA preguntes "vida util", "ingresos anuales", "valor de reventa", "depreciacion". Esos datos NO aplican.
2. La TIR CMU es simple: (Precio CMU - Costo Total) / Costo Total. Ya tienes todos los datos.
3. Si Josue da marca + precio + reparacion, CALCULA DIRECTO. NO pidas confirmacion.
4. Solo pregunta lo que FALTA (marca/modelo si no lo dio, precio si no lo dio).
5. Si ya se discutio un modelo en la conversacion, asumelo sin preguntar.
6. Cuando el resultado es BUEN NEGOCIO, ofrece: "Quiere ver la corrida con conversion GNV?"
7. TODOS los calculos los hace el motor. Tu SOLO presentas los resultados que recibes. NO calcules por tu cuenta.

Cuando el motor te da la evaluacion pre-calculada (marcada con [EVAL_RESULT]), presentala TAL CUAL. No la resumas ni la modifiques.

Base de conocimiento del programa:
{knowledgeBase}

{evalData}

{rulesContext}

REGLA DE PRECIO MAXIMO: El precio CMU nunca puede exceder el promedio de mercado del vehiculo sin GNV. Si el motor detecta esto, muestra "PRECIO TOPE" en la evaluacion.

REGLA DE PRECIOS DE MERCADO: Puedes consultar precios de mercado de CUALQUIER vehiculo, no solo los del catalogo CMU. Si el usuario pide precio de un modelo que no esta en catalogo (ej. Versa, Sentra, Spark, Cavalier), busca igualmente con marca/modelo/anio. NUNCA digas "no tengo acceso a informacion externa" — siempre tienes la herramienta de busqueda de mercado disponible.

=== ESTADO DE LA CONVERSACIÓN ===
{stateContext}

Comandos rápidos:
- [modelo] [costo]k rep [rep]: evaluación instantánea
- "91,500" o "95.5k" o "100k 25k": formatos aceptados
- inventario: flota actual
- folios: expedientes activos
- numeros / dashboard: métricas
- corrida [modelo]: tabla amortización
- mercado [modelo]: precios de mercado Kavak/MercadoLibre
- Varias líneas: evaluación en lote

{lastModelContext}

Modelos en catálogo CMU: {modelos}

{context}
Responde SOLO el mensaje de WhatsApp. Sin emojis.`;

// ===== Vision Prompts (v9 — trained on real Aguascalientes documents) =====
const CLASSIFY_PROMPT = `Eres un sistema OCR especializado en documentos mexicanos para el programa CMU en Aguascalientes.
Tu trabajo: clasificar el documento, extraer TODOS los datos visibles, y verificar calidad.

CLASIFICACION — identifica el tipo EXACTO:

1. ine_frente: Credencial INE frente. Tiene foto del titular, "INSTITUTO NACIONAL ELECTORAL", "CREDENCIAL PARA VOTAR", escudo nacional. Campos: NOMBRE, DOMICILIO, CLAVE DE ELECTOR, CURP, FECHA DE NACIMIENTO, SECCION, AÑO DE REGISTRO, VIGENCIA, SEXO, ESTADO, MUNICIPIO.

2. ine_reverso: Credencial INE reverso. Tiene código MRZ (líneas que empiezan con IDMEX seguido de números, y después apellido<<nombre). Tiene QR grande, código de barras, logo INE. NO tiene foto del titular. IMPORTANTE: Extraer el numero_ine de la línea MRZ: los 10 dígitos después de IDMEX (ej: IDMEX2835541426 → numero_ine=2835541426). Extraer CURP de segunda línea MRZ. Extraer fecha_expiracion.

3. tarjeta_circulacion: Dice "TARJETA DE CIRCULACIÓN" en header. Puede ser de "Secretaría de Finanzas" o "Secretaría de Seguridad Pública". Tiene: NOMBRE DEL PROPIETARIO, RFC, NIV (Número de Identificación Vehicular), NÚMERO DE MOTOR, MARCA, MODELO (año), PLACAS, COLOR, USO (TAXI/COLECTIVO/PARTICULAR), TIPO DE COMB (GASOLINA/GAS). Tiene sello SCT circular. NO confundir con concesión.

4. factura_vehiculo: Factura CFDI. Tiene UUID, folio fiscal, logo SAT, datos del emisor/receptor, descripción del vehículo con NIV/serie.

5. csf: Constancia de Situación Fiscal del SAT. Header: "CÉDULA DE IDENTIFICACIÓN FISCAL" + "CONSTANCIA DE SITUACIÓN FISCAL". Logos Hacienda|SAT. Tiene: RFC, CURP, nombre, domicilio fiscal, fecha de emisión. IMPORTANTE: Si dice "ACUSE DE MOVIMIENTOS DE ACTUALIZACIÓN" NO es CSF — clasificar como "otro" con note "Este es un acuse, no la Constancia de Situación Fiscal".

6. comprobante_domicilio: Recibo de servicios: CFE (logo verde, consumo kWh), JMAS/agua, Telmex, Izzi. Tiene: titular, dirección, fecha del periodo.

7. concesion: Dice "CONCESIÓN" en grande. Documento del gobierno de Aguascalientes. Tiene: número de concesión, titular ("al C."), modalidad (TAXI/COLECTIVO FORÁNEO), ruta, vigencia, folio, foto del titular, escudo estatal, firma del Secretario. Puede decir "Contigo al 100".

8. estado_cuenta: Documento bancario (Banamex, Banorte, BBVA, Santander, HSBC, etc). Puede ser carátula de cuenta, contrato, o solicitud bancaria. BUSCAR: CLABE (18 dígitos, puede estar etiquetada como "CLABE" o en formato XXX XXX XXXXXXXXXXX X), titular, banco. La CLABE puede venir en un estado de cuenta, carátula, o contrato/solicitud bancaria.

9. historial_gnv: Tickets/vouchers de GNV, NATGAS. Tienen litros, fecha, estación.

10. carta_membresia: Carta de agrupación gremial de taxistas.

11. selfie_biometrico: Foto de persona sosteniendo su INE junto al rostro.

12. ine_operador: INE de una persona DIFERENTE al titular de la concesión. Es el operador del taxi. Mismos campos que ine_frente pero cross-check contra nombre del operador, no del titular.

13. licencia_conducir: Licencia de conducir mexicana. Tiene: nombre, número de licencia, categoría (A/B/C/D/E), vigencia, estado emisor, foto. Puede ser del titular o del operador.

14. fotos_unidad: Foto del vehículo actual del taxista (no del vehículo CMU). 4 ángulos: frente, trasera, lateral izquierda, lateral derecha. Extraer: ángulo, color, estado visual, si se ven placas.

OTROS documentos que pueden llegar:
- Constancia CURP de SEGOB (tiene logo SEGOB, bandera mexicana, "Constancia de la Clave Única de Registro de Población") → clasificar como "otro" con note "Esto es constancia CURP, no CSF. Necesitamos la Constancia de Situación Fiscal del SAT."
- Voucher de depósito bancario → clasificar como "otro" con note "Comprobante de depósito recibido."
- Acuse de movimientos SAT → clasificar como "otro" con note "Este es un acuse del SAT, no la Constancia de Situación Fiscal. Necesitamos la CSF (Cédula de Identificación Fiscal)."

INSTRUCCIONES DE EXTRACCION:
- Extrae TODOS los campos visibles, no solo los principales.
- Si la imagen está rotada 90°, léela correctamente.
- Para INE reverso: parsea las 3 líneas MRZ caracter por caracter.
- Para tarjeta de circulación: extrae NIV completo (17 caracteres), placas, y verifica si uso=TAXI.
- Para CSF: verifica fecha de emisión (<30 días de antigüedad).
- Para estado de cuenta: la CLABE es PRIORITARIA — búscala en todo el documento.

Calidad de imagen: buena (legible), regular (algunos campos difíciles), mala (ilegible, borrosa, cortada).
Cross-check estos datos del perfil del taxista: {profile}

Responde SOLO JSON SIN markdown:
{"classifiedAs":"key","confidence":"alta/media/baja","quality":"buena/regular/mala","qualityIssue":null,"extractedData":{},"inconsistencies":[],"note":"breve"}`;

// Legacy prompt for non-document images (vehicles)
const CLASSIFY_PROMPT_SHORT = `Analiza esta imagen de documento mexicano. Clasifica: ${DOC_ORDER.map(d => `${d.key}: ${d.visualId}`).join(" | ")} | otro | ilegible
Calidad. Extrae datos. Cross-check vs: {profile}
JSON SIN markdown: {"classifiedAs":"key","confidence":"alta/media/baja","quality":"buena/regular/mala","qualityIssue":null,"extractedData":{},"inconsistencies":[],"note":"breve"}`;

const VEHICLE_VISION = `Identifica este vehículo: marca, modelo, año, color, estado. JSON: {"brand":"","model":"","year":2021,"color":"","condition":"","notes":""}`;

// ===== Non-Catalog Model type (for lastModel that's not in DB) =====
type VirtualModel = {
  id: number;
  brand: string;
  model: string;
  variant: string | null;
  slug: string;
  year: number;
  cmu: number;
  purchaseBenchmarkPct: number;
  _virtual: true;
};

// ===== Agent Class =====
export class WhatsAppAgent {
  private storage: IStorage;
  private key: string;
  private cachedFuel: ReturnType<typeof calcFuelContext> | null = null;
  private cachedFuelTime = 0;

  constructor(storage: IStorage, openaiKey: string) {
    this.storage = storage;
    this.key = openaiKey;
  }

  // Get fuel context (cached for 5 minutes)
  private async getFuel(): Promise<ReturnType<typeof calcFuelContext>> {
    if (this.cachedFuel && Date.now() - this.cachedFuelTime < 5 * 60 * 1000) return this.cachedFuel;
    const fp = await this.storage.getFuelPrices();
    this.cachedFuel = calcFuelContext(fp);
    this.cachedFuelTime = Date.now();
    return this.cachedFuel;
  }

  // Get business rules (cached in business-rules.ts with 5min TTL)
  private async getRules(): Promise<RulesMap> {
    return getBusinessRules();
  }

  // ===== Conversation State Management (v9 — DB-backed) =====
  private async getConvState(phone: string): Promise<ConvSession> {
    return getConvSession(phone);
  }

  private async updateState(phone: string, updates: Partial<Pick<ConvSession, "state" | "context" | "lastModel" | "folioId">>): Promise<void> {
    return updateConvSession(phone, updates);
  }

  private recordMessage(phone: string, role: "user" | "assistant", content: string): void {
    addConvMessage(phone, role, content);
  }

  private getHistoryForLLM(phone: string, limit = 10): Array<{ role: "user" | "assistant"; content: string }> {
    return getConvHistory(phone, limit);
  }

  private async getLastModel(phone: string): Promise<Model | VirtualModel | null> {
    const session = await this.getConvState(phone);
    return session.lastModel;
  }

  private async setLastModel(phone: string, model: Model | VirtualModel): Promise<void> {
    await this.updateState(phone, { lastModel: model as any });
  }

  // Store a non-catalog model as a VirtualModel so the agent remembers it
  private buildVirtualModel(brand: string, modelName: string, year: number): VirtualModel {
    const slug = `${brand.toLowerCase()}-${modelName.toLowerCase()}-${year}`;
    return {
      id: -1,
      brand,
      model: modelName,
      variant: null,
      slug,
      year,
      cmu: 0, // no CMU price
      purchaseBenchmarkPct: 0.65,
      _virtual: true,
    };
  }

  private isVirtualModel(m: any): m is VirtualModel {
    return m && m._virtual === true;
  }

  // ===== Profile / Pending =====
  private async buildProfile(oid: number): Promise<string> {
    const docs = await this.storage.getDocumentsByOrigination(oid);
    const profile: Record<string, any> = {};
    const captured: string[] = [];
    for (const doc of docs) {
      const d = doc as any;
      if (!(d.imageData || d.image_data)) continue;
      captured.push(d.tipo);
      const raw = d.ocrResult || d.ocr_result;
      if (raw) { try { profile[d.tipo] = typeof raw === "string" ? JSON.parse(raw) : raw; } catch {} }
    }
    const lines = [`Docs: ${captured.length}/${DOC_ORDER.length}`];
    if (captured.length > 0) lines.push(`Recibidos: ${captured.map(k => DOC_LABELS[k] || k).join(", ")}`);
    for (const [key, data] of Object.entries(profile)) {
      lines.push(`--- ${DOC_LABELS[key] || key} ---`);
      for (const [f, v] of Object.entries(data as any)) { if (v) lines.push(`${f}: ${v}`); }
    }
    return lines.join("\n") || "Sin datos.";
  }

  private async getPendingInfo(oid: number): Promise<{ text: string; nextKey: string | null; count: number }> {
    const docs = await this.storage.getDocumentsByOrigination(oid);
    const captured = new Set(docs.filter((d: any) => d.imageData || d.image_data).map((d: any) => d.tipo));
    const pending = DOC_ORDER.filter(d => !captured.has(d.key));
    if (pending.length === 0) return { text: "✅ Todos recibidos.", nextKey: null, count: captured.size };
    return { text: `Siguiente: ${pending[0].label} | Faltan: ${pending.map(d => d.label).join(", ")}`, nextKey: pending[0].key, count: captured.size };
  }

  // ===== LLM =====
  private async llm(messages: any[], maxTok = 600): Promise<string> {
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { "Authorization": `Bearer ${this.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens: maxTok, temperature: 0.5 }),
      });
      const d = await r.json();
      if (d.error) { console.error("[Agent]", d.error.message); return "Tuve un problema, intenta de nuevo."; }
      return d.choices?.[0]?.message?.content || "Sin respuesta.";
    } catch (e: any) { console.error("[Agent]", e.message); return "Error de conexión."; }
  }

  // ===== Vision =====
  private async vision(imageBase64: string, profile: string, expectedKey?: string): Promise<{
    classifiedAs: string; isValid: boolean; extractedData: Record<string, any>; note: string;
  }> {
    const prompt = CLASSIFY_PROMPT.replace("{profile}", profile) + (expectedKey ? `\nESPERADO: ${DOC_LABELS[expectedKey]}` : "");
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { "Authorization": `Bearer ${this.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageBase64, detail: "high" } },
        ]}], max_tokens: 1000, temperature: 0.1 }),
      });
      const d = await r.json();
      const content = d.choices?.[0]?.message?.content || "{}";
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        const p = JSON.parse(match[0]);
        return {
          classifiedAs: p.classifiedAs || "otro", isValid: p.quality !== "mala" && p.classifiedAs !== "ilegible",
          extractedData: p.extractedData || {},
          note: [p.note, ...(p.inconsistencies || []).map((i: string) => `⚠️ ${i}`), p.qualityIssue ? `📸 ${p.qualityIssue}` : ""].filter(Boolean).join(" | "),
        };
      }
      return { classifiedAs: "otro", isValid: true, extractedData: {}, note: "Recibido." };
    } catch (e: any) { return { classifiedAs: expectedKey || "otro", isValid: true, extractedData: {}, note: "Recibido (sin análisis)." }; }
  }

  private async identifyVehicle(imageBase64: string): Promise<{ brand: string; model: string; year: number; notes: string } | null> {
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { "Authorization": `Bearer ${this.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: [
          { type: "text", text: VEHICLE_VISION },
          { type: "image_url", image_url: { url: imageBase64, detail: "high" } },
        ]}], max_tokens: 300, temperature: 0.1 }),
      });
      const d = await r.json();
      const match = (d.choices?.[0]?.message?.content || "").match(/\{[\s\S]*\}/);
      if (match) { const p = JSON.parse(match[0]); return { brand: p.brand, model: p.model, year: p.year, notes: p.notes || "" }; }
    } catch {} return null;
  }

  // ===== PDF + Image Media Processing =====
  private async downloadMedia(mediaUrl: string, mediaType: string | null): Promise<{ base64: string; wasPdf: boolean; pdfText?: string }> {
    const SID = process.env.TWILIO_ACCOUNT_SID;
    const TOK = process.env.TWILIO_AUTH_TOKEN;
    const r = await fetch(mediaUrl, {
      headers: SID && TOK ? { "Authorization": "Basic " + Buffer.from(`${SID}:${TOK}`).toString("base64") } : {},
    });
    const buf = Buffer.from(await r.arrayBuffer());
    
    // Log mediaType + content-type for debugging
    const responseContentType = r.headers.get("content-type") || "";
    console.log(`[Agent] downloadMedia: mediaType=${mediaType}, content-type=${responseContentType}, size=${buf.length}`);

    // Detect CSV/Excel by MIME type first
    let isCsv = mediaType && (mediaType.includes("csv") || mediaType.includes("text/tab-separated"));
    let isExcel = mediaType && (mediaType.includes("excel") || mediaType.includes("spreadsheet") || mediaType.includes("openxmlformats") || mediaType.includes("ms-excel"));
    
    // Also check response content-type (Twilio sometimes rewrites)
    if (!isCsv && !isExcel) {
      if (responseContentType.includes("csv") || responseContentType.includes("tab-separated")) isCsv = true;
      if (responseContentType.includes("excel") || responseContentType.includes("spreadsheet") || responseContentType.includes("openxmlformats")) isExcel = true;
    }
    
    // Fallback: sniff content for octet-stream or text/plain
    if (!isCsv && !isExcel && (mediaType?.includes("octet-stream") || mediaType?.includes("text/plain") || !mediaType)) {
      // Excel magic bytes: PK (ZIP) = 0x50 0x4B (xlsx) or 0xD0 0xCF (xls)
      if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B) {
        isExcel = true;
        console.log(`[Agent] Detected XLSX by magic bytes (PK/ZIP header)`);
      } else if (buf.length > 4 && buf[0] === 0xD0 && buf[1] === 0xCF) {
        isExcel = true;
        console.log(`[Agent] Detected XLS by magic bytes (OLE header)`);
      } else {
        // Try text: check if first 500 chars contain CSV-like patterns
        const head = buf.slice(0, 500).toString("utf-8");
        if ((head.toLowerCase().includes("placa") || head.toLowerCase().includes("financiera")) && 
            (head.includes(",") || head.includes("\t") || head.includes(";"))) {
          isCsv = true;
          console.log(`[Agent] Detected CSV by content sniffing (contains Placa/Financiera headers)`);
        } else if (head.toLowerCase().includes("placa") || head.toLowerCase().includes("recaudo")) {
          isCsv = true;
          console.log(`[Agent] Detected CSV by keyword sniffing`);
        }
      }
    }
    
    if (isCsv) {
      console.log(`[Agent] Processing CSV (${buf.length} bytes)`);
      return { base64: "", wasPdf: false, pdfText: buf.toString("utf-8"), _isCsv: true } as any;
    }
    if (isExcel) {
      console.log(`[Agent] Processing Excel (${buf.length} bytes)`);
      return { base64: "", wasPdf: false, pdfText: null, _isExcel: true, _excelBuffer: buf } as any;
    }

    // If it's a PDF, process it
    if (isPdf(mediaType)) {
      console.log(`[Agent] Processing PDF (${buf.length} bytes)`);
      const result = await processPdf(buf);
      if (result.type === "text" && result.text) {
        // Native PDF with extractable text
        return { base64: "", wasPdf: true, pdfText: result.text };
      } else if (result.type === "image" && result.imageBase64) {
        // Scanned PDF converted to image
        return { base64: result.imageBase64, wasPdf: true };
      }
      // Fallback: couldn't process
      return { base64: "", wasPdf: true, pdfText: "(PDF no legible)" };
    }

    // Regular image
    const base64 = `data:${mediaType || "image/jpeg"};base64,${buf.toString("base64")}`;
    return { base64, wasPdf: false };
  }

  // Process document via Vision (image) or text extraction (PDF)
  private async processDocument(
    media: { base64: string; wasPdf: boolean; pdfText?: string },
    profile: string, expectedKey?: string
  ): Promise<{ classifiedAs: string; isValid: boolean; extractedData: Record<string, any>; note: string }> {
    // If we have extracted text from a native PDF, use LLM text analysis instead of Vision
    if (media.wasPdf && media.pdfText && !media.base64) {
      const prompt = `Analiza este texto extraído de un PDF mexicano. Clasifica el documento y extrae datos.

Tipos posibles: ${DOC_ORDER.map(d => d.key + ": " + d.label).join(" | ")} | otro

Texto del PDF:
${media.pdfText.slice(0, 3000)}

Cross-check vs perfil: ${profile}

JSON SIN markdown: {"classifiedAs":"key","confidence":"alta/media/baja","quality":"buena","qualityIssue":null,"extractedData":{},"inconsistencies":[],"note":"breve"}`;
      try {
        const response = await this.llm([{ role: "user", content: prompt }], 1000);
        const match = response.match(/\{[\s\S]*\}/);
        if (match) {
          const p = JSON.parse(match[0]);
          return {
            classifiedAs: p.classifiedAs || "otro",
            isValid: p.classifiedAs !== "otro",
            extractedData: p.extractedData || {},
            note: [p.note, ...(p.inconsistencies || []).map((i: string) => `\u26a0\ufe0f ${i}`)].filter(Boolean).join(" | "),
          };
        }
      } catch (e: any) { console.error("[Agent] PDF text analysis error:", e.message); }
      return { classifiedAs: "otro", isValid: false, extractedData: {}, note: "PDF recibido pero no pude clasificar." };
    }

    // Regular image or PDF-converted-to-image: use Vision
    if (media.base64) {
      return await this.vision(media.base64, profile, expectedKey);
    }

    return { classifiedAs: "otro", isValid: false, extractedData: {}, note: "Archivo no procesable." };
  }

  // ===== Flexible Folio Search =====
  async findFolio(query: string): Promise<{ id: number; folio: string; taxistaName: string | null }[]> {
    try {
      const results = await this.storage.findFolioFlexible(query);
      return results.map(r => ({ id: (r.origination as any).id, folio: (r.origination as any).folio, taxistaName: r.taxistaName }));
    } catch { return []; }
  }

  // ===== Market Prices (Kavak + MercadoLibre) =====
  private async fetchMarketPrices(brand: string, model: string, year: number, variant?: string | null): Promise<{
    avg: number | null; min: number | null; max: number | null; median: number | null; count: number; sources: string; fallback: boolean;
  }> {
    try {
      const r = await fetch("http://localhost:5000/api/cmu/market-prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, model, year, variant }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await r.json();
      const srcList = (data.sources || []).map((s: any) => `${s.name}(${s.count})`).join(", ");
      return {
        avg: data.average || null, min: data.min || null, max: data.max || null,
        median: data.median || null, count: data.count || 0,
        sources: srcList || "sin datos", fallback: data.fallback ?? true,
      };
    } catch (e: any) {
      console.error("[Agent] Market prices error:", e.message);
      return { avg: null, min: null, max: null, median: null, count: 0, sources: "error", fallback: true };
    }
  }

  // ===== CANAL C: DYNAMIC Motor CMU =====
  // v9 FIX: parseEvalLine now handles:
  //   "91,500" (comma thousands) → 91500
  //   "95.5k" (decimal k) → 95500
  //   "100k 25k" (two numbers without 'rep' = cost + repair)
  //   "me lo venden en 91,500" (natural language with comma number)
  //   "$91,500" (dollar sign + comma)
  private parseEvalLine(line: string): { modelQuery: string | null; cost: number | null; repair: number | null; year: number | null; conTanque: boolean } {
    const lower = line.toLowerCase().trim();
    let cost: number | null = null;
    let repair: number | null = null;
    let year: number | null = null;
    let conTanque = true;

    // Extract year
    const yearMatch = lower.match(/20(2[1-9]|3[0-9])/);
    if (yearMatch) year = parseInt(yearMatch[0]);

    // Extract repair FIRST (before cost, so we don't confuse "rep 25k" with cost)
    const repMatch = lower.match(/rep(?:araci[oó]n)?(?:\s+(?:es\s+)?(?:de\s+)?)?\$?\s*(\d{1,3}(?:\.\d+)?)\s*(?:mil|k)/i)
      || lower.match(/rep(?:araci[oó]n)?(?:\s+(?:es\s+)?(?:de\s+)?)?\$?\s*(\d{1,3}),(\d{3})/i)
      || lower.match(/rep(?:araci[oó]n)?(?:\s+(?:es\s+)?(?:de\s+)?)?\$?\s*(\d{4,6})/i)
      || lower.match(/rep\s+(\d{1,3})\s*k?\b/i);
    if (repMatch) {
      if (repMatch[2]) {
        // "rep 25,000" format
        repair = parseInt(repMatch[1] + repMatch[2]);
      } else {
        const v = parseFloat(repMatch[1]);
        if (v < 1000) repair = Math.round(v * 1000); // 25 → 25000, 25.5 → 25500
        else repair = Math.round(v); // 25000 → 25000
      }
    }

    // Remove the repair portion so it doesn't interfere with cost extraction
    let forCost = lower;
    if (repMatch) forCost = forCost.replace(repMatch[0], " ");

    // Extract cost patterns (in priority order)
    // Pattern 1: "95.5k" or "95,5k" (decimal/comma + k) → 95500
    const decimalKMatch = forCost.match(/(\d{2,3})[.,](\d{1,2})\s*k\b/);
    if (decimalKMatch && !cost) {
      const intPart = parseInt(decimalKMatch[1]);
      const decPart = decimalKMatch[2].length === 1 ? parseInt(decimalKMatch[2]) * 100 : parseInt(decimalKMatch[2]) * 10;
      cost = intPart * 1000 + decPart;
    }

    // Pattern 2: "130k" or "130 k" (integer k)
    if (!cost) {
      const intKMatch = forCost.match(/(\d{2,3})\s*k(?:\b|$)/);
      if (intKMatch) cost = parseInt(intKMatch[1]) * 1000;
    }

    // Pattern 3: "91,500" or "$91,500" or "91.500" (comma/dot thousands separator) — NOT LEQ
    if (!cost) {
      const commaMatch = forCost.match(/\$?\s*(\d{2,3})[,.](\d{3})(?!\s*leq)/);
      if (commaMatch) cost = parseInt(commaMatch[1] + commaMatch[2]);
    }

    // Pattern 4: "130 mil" or "130mil"
    if (!cost) {
      const milMatch = forCost.match(/(\d{2,3})\s*mil/);
      if (milMatch) cost = parseInt(milMatch[1]) * 1000;
    }

    // Pattern 5: Raw 5-6 digit number that looks like a price (50000-999999)
    if (!cost) {
      const rawMatch = forCost.match(/(?:^|\s)\$?\s*(\d{5,6})(?:\s|$)/);
      if (rawMatch) cost = parseInt(rawMatch[1]);
    }

    // v9 FIX: Two numbers without 'rep' = cost + repair (e.g., "aveo 100k 25k")
    // Only trigger when there are genuinely TWO separate Xk patterns (not decimal like "95.5k")
    if (cost && !repair) {
      // Count how many separate Xk patterns exist (integer k only, not decimal)
      const allKMatches = forCost.match(/(?:^|\s)(\d{2,3})\s*k\b/g);
      if (allKMatches && allKMatches.length >= 2) {
        // First match is cost (already parsed), second is repair
        const secondMatch = allKMatches[1].trim().match(/(\d{1,3})\s*k/);
        if (secondMatch) repair = parseInt(secondMatch[1]) * 1000;
      } else {
        // Check for mixed formats: "100k 25,000"
        const afterCostStr = forCost.replace(/(\d{2,3})\s*k\b/, "MATCHED").replace(/(\d{2,3})[,.](\d{3})/, "MATCHED");
        const secondComma = afterCostStr.match(/(\d{1,3})[,.](\d{3})/);
        if (secondComma) repair = parseInt(secondComma[1] + secondComma[2]);
      }
    }

    // Tank
    if (lower.includes("sin tanque") || lower.includes("tanque nuevo")) conTanque = false;

    // Model query: remove numbers, noise words, rep, k, josue, evalua
    let modelQuery: string | null = lower.replace(/josu[eé]\s*/i, "").replace(/eval[uú]a?\s*/i, "")
      .replace(/\d{2,3}[.,]\d{1,2}\s*k\b/g, "") // "95.5k"
      .replace(/\d{2,3}\s*k\b/g, "") // "130k"
      .replace(/\$?\s*\d{2,3}[,.]\d{3}/g, "") // "$91,500"
      .replace(/\d{2,3}\s*mil/g, "") // "130 mil"
      .replace(/rep(?:araci[oó]n)?(?:\s+(?:es\s+)?(?:de\s+)?)?\$?\s*\d+\s*k?/gi, "")
      .replace(/\brep\b/gi, "") // clean leftover "rep" after number removal
      .replace(/\$[\d,.]+/g, "").replace(/20\d{2}/g, "").replace(/sin tanque|tanque nuevo/gi, "")
      .replace(/\d{5,6}/g, "") // raw prices
      // v9: Strip common noise words that confuse model detection
      .replace(/\b(precio|precios|compra|costo|adquisici[oó]n|adquisicion|venta|me\s+lo|lo|venden|piden|en|de|la|el|es|y|con|del|al|mil|pesos)\b/gi, "")
      .replace(/\s+/g, " ").trim();
    if (modelQuery.length < 2) modelQuery = null;

    return { modelQuery, cost, repair, year, conTanque };
  }

  private async resolveModel(query: string, year?: number | null): Promise<Model | undefined> {
    const models = await this.storage.getModels();
    // Normalize: lowercase, remove spaces AND hyphens ("vdrive" = "v-drive" = "v drive")
    const norm = (s: string) => s.toLowerCase().replace(/[\s\-]+/g, "");
    const q = norm(query);
    
    // Find all models matching the name
    const nameMatches = models.filter((m: any) => {
      const slug = norm(`${m.model}${m.variant || ""}`);
      const slugFull = norm(`${m.brand}${m.model}${m.variant || ""}`);
      const dbSlug = norm(m.slug || "");
      return slug.includes(q) || q.includes(slug) || slugFull.includes(q) || dbSlug.includes(q) || q.includes(dbSlug);
    });
    
    if (nameMatches.length === 0) return undefined; // Model name not in catalog at all
    
    if (year) {
      // Exact year match
      const exact = nameMatches.find((m: any) => m.year === year);
      if (exact) return exact as Model;
      
      // Year not found: check how far off we are
      const catalogYears = [...new Set(nameMatches.map((m: any) => m.year as number))];
      const closest = catalogYears.reduce((a, b) => Math.abs(b - year) < Math.abs(a - year) ? b : a);
      const diff = Math.abs(year - closest);
      
      if (diff <= 1) {
        // Within 1 year → use closest, note the difference
        const closestModel = nameMatches.find((m: any) => m.year === closest);
        if (closestModel) {
          console.log(`[ResolveModel] ${q} ${year} not in catalog, using closest year ${closest} (diff=${diff})`);
          return closestModel as Model;
        }
      }
      // More than 1 year off → return undefined to trigger market-based flow
      console.log(`[ResolveModel] ${q} ${year} not in catalog, closest is ${closest} (diff=${diff}) — triggering market flow`);
      return undefined;
    }
    
    // No year specified — return newest
    const sorted = nameMatches.sort((a: any, b: any) => b.year - a.year);
    return sorted[0] as Model;
  }

  // Check if a model name has multiple variants in catalog (e.g. March Sense vs March Advance)
  private async getVariantsForModel(modelName: string): Promise<string[]> {
    try {
      const models = await this.storage.getModels();
      const normalizedQuery = modelName.toLowerCase().replace(/\s+/g, "");
      const matching = models.filter((m: any) => {
        const norm = (m.model || "").toLowerCase().replace(/\s+/g, "");
        return norm.includes(normalizedQuery) || normalizedQuery.includes(norm);
      });
      const variants = [...new Set(matching.map((m: any) => m.variant).filter(Boolean))];
      return variants as string[];
    } catch { return []; }
  }

  // Auto-create a catalog entry from market data
  private async autoInsertCatalogModel(brand: string, model: string, variant: string | null, year: number, cmu: number): Promise<void> {
    try {
      const slug = `${brand}-${model}${variant ? "-" + variant : ""}`.toLowerCase().replace(/\s+/g, "-");
      await this.storage.createModel({
        brand, model, variant, year, cmu,
        slug, cmuSource: "mercado_auto", purchaseBenchmarkPct: 0.65,
        cmuUpdatedAt: new Date().toISOString(),
      } as any);
      console.log(`[Catalog] Auto-inserted: ${brand} ${model} ${variant || ""} ${year} CMU=$${cmu}`);
    } catch (e: any) {
      console.error(`[Catalog] Auto-insert failed: ${e.message}`);
    }
  }

  private formatEvalResult(r: EvaluationResult, marketData?: { avg: number | null; min: number | null; max: number | null; median: number | null; count: number; sources: string; fallback: boolean }, gnvRevenue?: number, thresholds?: ReturnType<typeof getThresholds>): string {
    const pctCmu = (r.costoPctCmu * 100).toFixed(1);
    const tirB = (r.tirBase * 100).toFixed(1);
    const tirO = (r.tirOperativa * 100).toFixed(1);
    const tirC = (r.tirCompleta * 100).toFixed(1);

    const cuotaM1 = r.amortizacion[0]?.cuota || 0;
    const cuotaM3 = r.amortizacionConAnticipo.length >= 3 ? r.amortizacionConAnticipo[2]?.cuota || cuotaM1 : cuotaM1;
    const gnv = gnvRevenue || 4400;

    const lines = [
      `*EVALUACION — ${r.brand} ${r.model}${r.variant ? " " + r.variant : ""} ${r.year}*`,
      ``,
      `*COSTOS*`,
      `Aseguradora: $${r.insurerPrice.toLocaleString()}`,
      `Reparación: $${r.repairEstimate.toLocaleString()}`,
      `Kit GNV: $${r.kitGnv.toLocaleString()}${r.conTanque ? " (con tanque)" : " (sin tanque)"}`,
      `*Costo total: $${r.totalCost.toLocaleString()}*`,
      ``,
      `*PRECIO CMU*`,
      `Contado: $${r.precioContado.toLocaleString()}`,
      `A plazos (36m): $${r.ventaPlazos.toLocaleString()}`,
      `%CMU: *${pctCmu}%*`,
      `Margen: *$${r.margin.toLocaleString()}*`,
      `PV mínimo: $${r.pvMinimo.toLocaleString()}${r.precioContado >= r.pvMinimo ? " ✅" : " ❌"}`,
      r.precioCapped ? `⚠️ Precio tope: ajustado a mercado $${r.precioMaxCMU.toLocaleString()}` : 
      (r as any).precioAjustado ? `🟢 PV ajustado: catálogo $${((r as any).precioOriginal || r.cmu).toLocaleString()} → mercado×0.95 = $${r.precioContado.toLocaleString()}` : "",
    ];

    if (marketData && marketData.avg && marketData.count > 0) {
      lines.push(
        ``,
        `*MERCADO* (${marketData.count} listings)`,
        `Promedio: $${marketData.avg.toLocaleString()} | Mediana: $${(marketData.median || 0).toLocaleString()}`,
        `Rango: $${(marketData.min || 0).toLocaleString()} — $${(marketData.max || 0).toLocaleString()}`,
        `Fuentes: ${marketData.sources}${marketData.fallback ? " (catálogo)" : ""}`,
      );
    }

    lines.push(
      ``,
      `*RENTABILIDAD*`,
      `TIR Base: ${tirB}% | Operativa: ${tirO}% | Completa: ${tirC}%`,
      `MOIC: ${r.moic.toFixed(2)}x`,
      r.mesGnvCubre ? `GNV cubre cuota: mes ${r.mesGnvCubre}` : "",
      r.paybackMonth ? `Payback: mes ${r.paybackMonth}` : "",
    );

    // v11: Guardrails
    const gPassed = r.guardrailsPassed;
    const gTotal = r.guardrails.length;
    lines.push(
      ``,
      `*FILTROS (${gPassed}/${gTotal})*`,
    );
    for (const g of r.guardrails) {
      lines.push(`${g.passed ? "✅" : "❌"} ${g.label}: ${g.value} (${g.threshold})`);
    }

    // v11: Risk assessment
    const risk = r.riesgoCliente;
    const riskEmoji = risk.nivel === "BAJO" ? "🟢" : risk.nivel === "MEDIO" ? "🟡" : "🔴";
    lines.push(
      ``,
      `*RIESGO CLIENTE* ${riskEmoji} ${risk.nivel}`,
      `Diferencial m1: $${risk.diferencialM1.toLocaleString()} | m3: $${risk.diferencialM3.toLocaleString()}`,
      `Pago extra taxista m1: $${Math.max(0, cuotaM1 - gnv + CMU.fondoMensual).toLocaleString()}/mes`,
      `Pago extra taxista m3+: $${Math.max(0, cuotaM3 - gnv + CMU.fondoMensual).toLocaleString()}/mes`,
    );

    // Verdict
    let verdictEmoji: string;
    let verdictText: string;
    if (r.decision === "COMPRAR") {
      verdictEmoji = "✅";
      verdictText = "COMPRAR";
    } else if (r.decision === "VIABLE") {
      verdictEmoji = "⚠️";
      verdictText = "CONDICIONAL";
    } else {
      verdictEmoji = "❌";
      verdictText = "NO COMPRAR";
    }

    lines.push(
      ``,
      `*VEREDICTO: ${verdictEmoji} ${verdictText} (${gPassed}/${gTotal})*`,
    );

    if (r.decision !== "NO COMPRAR") {
      lines.push(``, `¿Quiere ver la corrida completa con conversión GNV?`);
    }

    return lines.filter(Boolean).join("\n");
  }

  // Helper: detect if text is conversational (should go to LLM)
  private isConversational(text: string): boolean {
    const lower = text.toLowerCase();
    if (lower.includes("?")) return true;
    if (/^(hola|oye|podr[ií]as?|puedes|quer[ií]a|necesito|me |como |qu[eé] |hay |cu[aá]ndo|d[oó]nde|por qu[eé]|sabes|dime|oiga|mande|buenos? |buenas?)/.test(lower)) return true;
    const words = lower.split(/\s+/).length;
    if (words > 6 && !/\d{2,3}\s*k|rep\s*\d/i.test(lower)) return true;
    return false;
  }

  // Brand mapping: model name -> brand (for models not in CMU catalog)
  private static BRAND_MAP: Record<string, string> = {
    // Nissan
    "versa": "Nissan", "versa sense": "Nissan", "versa advance": "Nissan",
    "sentra": "Nissan", "tsuru": "Nissan", "march": "Nissan", "march sense": "Nissan", "march advance": "Nissan",
    "kicks": "Nissan", "sunny": "Nissan", "tiida": "Nissan", "note": "Nissan", "almera": "Nissan",
    // Chevrolet
    "aveo": "Chevrolet", "spark": "Chevrolet", "beat": "Chevrolet", "cavalier": "Chevrolet",
    "onix": "Chevrolet", "tornado": "Chevrolet", "sail": "Chevrolet", "sonic": "Chevrolet",
    // Volkswagen
    "vento": "Volkswagen", "gol": "Volkswagen", "polo": "Volkswagen", "virtus": "Volkswagen",
    "v-drive": "Nissan", "vdrive": "Nissan", "v drive": "Nissan",
    // Toyota
    "yaris": "Toyota", "yaris sedan": "Toyota", "corolla": "Toyota", "etios": "Toyota",
    // Hyundai
    "grand i10": "Hyundai", "i10": "Hyundai", "accent": "Hyundai", "i25": "Hyundai", "verna": "Hyundai",
    // Kia
    "rio": "Kia", "forte": "Kia", "soluto": "Kia",
    // Suzuki
    "swift": "Suzuki", "dzire": "Suzuki", "ciaz": "Suzuki",
    // Dodge
    "attitude": "Dodge",
    // Renault
    "kwid": "Renault", "logan": "Renault", "sandero": "Renault", "duster": "Renault", "stepway": "Renault",
    // BAIC / JAC / MG
    "d20": "BAIC", "sei2": "JAC", "sei3": "JAC", "mg5": "MG", "mg zs": "MG",
    // Honda / Fiat / Seat
    "city": "Honda", "fit": "Honda", "uno": "Fiat", "mobi": "Fiat", "ibiza": "SEAT",
  };

  // Known model names ordered longest-first so "march sense" matches before "march"
  private static KNOWN_MODELS = [
    "march sense", "march advance", "versa sense", "versa advance", "yaris sedan", "grand i10", "mg zs",
    "march", "aveo", "versa", "sentra", "tsuru", "kicks", "sunny", "tiida", "note", "almera",
    "v-drive", "vdrive", "v drive",
    "spark", "beat", "cavalier", "onix", "tornado", "sail", "sonic",
    "vento", "gol", "polo", "virtus",
    "yaris", "corolla", "etios",
    "i10", "accent", "verna",
    "rio", "forte", "soluto",
    "swift", "dzire", "ciaz",
    "attitude", "logan", "sandero", "kwid", "duster", "stepway",
    "d20", "sei2", "sei3", "mg5",
    "city", "fit", "uno", "mobi", "ibiza",
  ];

  // Helper: extract model name + brand from natural language
  private extractModelFromNaturalText(text: string): { modelName: string | null; brand: string | null; year: number | null } {
    const lower = text.toLowerCase();
    let found: string | null = null;
    for (const m of WhatsAppAgent.KNOWN_MODELS) {
      if (lower.includes(m)) { found = m; break; }
    }
    const brand = found ? (WhatsAppAgent.BRAND_MAP[found] || null) : null;
    const yearMatch = lower.match(/20(2[1-9]|3[0-9])/);
    if (!found) {
      const noise = /\b(precio|precios|mercado|market|dame|dime|dar|del|de|la|el|los|las|un|una|cuanto|cu[aá]nto|cuesta|vale|promedio|busca|buscar|quiero|ver|ahora|tambi[eé]n|nuevo|nueva|sedan|hatchback|me|te|se|nos|si|s[ií]|no|por|para|que|qu[eé]|como|c[oó]mo|con|sin|su|sus|al|pero|ya|hay|puede|puedes|podr[ií]as?|dar|tiene|tengo|cuentas?|cuenta|favor|hola|oye|oiga|bueno|pues|ese|esa|este|esta|esto|estos|estas|esos|esas|solo|s[oó]lo|cual|donde|cuando|porque|porqu[eé]|ser|son|era|fue|api|eso|otro|otra|otros|otras|bien|mal|muy|mas|m[aá]s|algo|nada|todo|todos|cada|mismo|aqu[ií]|ahi|ah[ií]|alla|all[aá]|venden|piden|reparaci[oó]n|reparacion|rep)\b/g;
      const cleaned = lower.replace(noise, "").replace(/20\d{2}/g, "").replace(/[?!¿¡.,;:]/g, "")
        .replace(/\d{2,3}\s*k\b/g, "").replace(/\$?\s*\d{2,3}[,.]\d{3}/g, "").replace(/\d{5,6}/g, "")
        .replace(/\s+/g, " ").trim();
      const words = cleaned.split(" ").filter(w => w.length >= 3 && !/^\d+$/.test(w));
      if (words.length > 0) {
        const knownBrands = ["nissan", "chevrolet", "chevy", "volkswagen", "vw", "toyota", "hyundai", "kia", "suzuki", "dodge", "renault", "baic", "jac", "honda", "mazda", "ford", "fiat", "seat", "mg", "chery"];
        let extractedBrand: string | null = null;
        let extractedModel: string | null = null;
        for (const w of words) {
          if (knownBrands.includes(w)) {
            extractedBrand = w === "chevy" ? "Chevrolet" : w === "vw" ? "Volkswagen" : w.charAt(0).toUpperCase() + w.slice(1);
          } else if (!extractedModel) {
            extractedModel = w;
          }
        }
        if (extractedModel) {
          found = extractedModel;
          if (!brand && extractedBrand) return { modelName: found, brand: extractedBrand, year: yearMatch ? parseInt(yearMatch[0]) : null };
        }
      }
    }
    return { modelName: found, brand, year: yearMatch ? parseInt(yearMatch[0]) : null };
  }

  // ===== Inventory query for WhatsApp =====
  async getAvailableInventory(): Promise<string> {
    const vehicles = await this.storage.listVehicles({ status: "disponible" });
    if (!vehicles.length) {
      // Fallback: try all vehicles and filter
      const all = await this.storage.listVehicles();
      const available = all.filter((v: any) => v.status === "disponible");
      if (!available.length) return "🚗 Por el momento no hay vehículos disponibles. Próximamente tendremos unidades listas.";
      return this.formatInventoryList(available);
    }
    return this.formatInventoryList(vehicles);
  }

  private formatInventoryList(vehicles: any[]): string {
    const lines = [`🚗 *Vehículos Disponibles* (${vehicles.length})\n`];
    for (let idx = 0; idx < Math.min(10, vehicles.length); idx++) {
      const vv = vehicles[idx] as any;
      const marca = vv.marca || vv.brand || "";
      const modelo = vv.modelo || vv.model || "";
      const variante = vv.variante || vv.variant || "";
      const anio = vv.anio || vv.year || "";
      const cmu = vv.cmu_valor || vv.cmuValor || 0;
      const color = vv.color ? ` ${vv.color}` : "";
      lines.push(`${idx + 1}. *${marca} ${modelo} ${variante} ${anio}*${color}`);
      if (cmu) lines.push(`   Precio: $${cmu.toLocaleString()} contado | 36 meses`);
    }
    if (vehicles.length > 10) lines.push(`\n... y ${vehicles.length - 10} más.`);
    lines.push(`\n¿Te interesa alguno? Pregunta por modelo y te doy la corrida.`);
    return lines.join("\n");
  }

  // v9 FIX: handleCanalC is now only for director-specific commands (dashboard, inventory, folios, eval, corrida, market prices)
  // Director ALSO has access to Canal A/B features (docs, origination, info) via handleMessage fallthrough
  private async handleCanalC(phone: string, body: string, mediaUrl: string | null, mediaType: string | null): Promise<string> {
    const cmd = body.replace(/^josu[eé]\s*/i, "").trim();
    const lower = cmd.toLowerCase();
    const fuelCtx = await this.getFuel();
    const fuelGnv = fuelCtx.gnvRevenueMes;
    const fuelGnvPrice = fuelCtx.gnvPrecioLeq;

    // Dashboard
    if (lower === "números" || lower === "numeros" || lower === "dashboard") {
      const origs = await this.storage.listOriginations();
      const vehicles = await this.storage.listVehicles();
      const activos = origs.filter((o: any) => !["RECHAZADO", "APROBADO"].includes(o.estado));
      return [`📊 *DASHBOARD CMU*`, `Folios activos: ${activos.length}`, `Vehículos: ${vehicles.length}`, `Disponibles: ${vehicles.filter((v: any) => v.status === "disponible").length}`].join("\n");
    }

    // Inventory
    if (lower === "inventario" || lower === "inv") {
      const vehicles = await this.storage.listVehicles();
      if (!vehicles.length) return "Sin vehículos en inventario.";
      const lines = [`🚗 *INVENTARIO* (${vehicles.length})\n`];
      for (let i = 0; i < Math.min(15, vehicles.length); i++) {
        const vv = vehicles[i] as any;
        const var_ = vv.variante ? ` ${vv.variante}` : "";
        const adq = vv.costo_adquisicion || 0;
        const rep = vv.costo_reparacion || 0;
        const kit = vv.kit_gnv_costo || 0;
        const tanque = vv.tanque_costo || 0;
        const cmu = vv.cmu_valor || 0;
        const total = adq + rep + kit + tanque;
        const margen = cmu > 0 ? cmu - total : 0;
        lines.push(`${i+1}. *${vv.marca} ${vv.modelo}${var_} ${vv.anio}* | ${vv.status}`);
        lines.push(`   Compra $${adq.toLocaleString()} | Rep $${rep.toLocaleString()} | GNV $${(kit+tanque).toLocaleString()}`);
        lines.push(`   PV: $${cmu.toLocaleString()} | Margen: $${margen.toLocaleString()}`);
      }
      return lines.join("\n");
    }

    // ===== INVENTORY EDIT WITH PIN (HU-2) =====
    // Detects: "reparacion aveo 30k", "cmu kwid 190k", "precio aseguradora march 110k"
    // Also handles PIN response when awaiting_inventory_edit state
    const editState = await this.getConvState(phone);
    
    // Step 2: PIN response
    if (editState.state === "awaiting_inventory_pin") {
      const pin = body.trim();
      if (pin === "123456") {
        const pending = editState.context.pendingEdit as any;
        if (pending) {
          try {
            const updated = await this.storage.updateVehicle(pending.vehicleId, pending.fields);
            await this.updateState(phone, { state: "idle", context: {} });
            if (updated) {
              const vv = updated as any;
              const adq = vv.costo_adquisicion || 0;
              const rep = vv.costo_reparacion || 0;
              const kit = vv.kit_gnv_costo || 0;
              const tanque = vv.tanque_costo || 0;
              const cmu = vv.cmu_valor || 0;
              const total = adq + rep + kit + tanque;
              const margen = cmu > 0 ? cmu - total : 0;
              return `Actualizado *${vv.marca} ${vv.modelo} ${vv.variante || ""} ${vv.anio}*:\n${pending.description}\nCosto total: $${total.toLocaleString()} | PV: $${cmu.toLocaleString()} | Margen: $${margen.toLocaleString()}`;
            }
            return "Actualizado.";
          } catch (e: any) {
            await this.updateState(phone, { state: "idle", context: {} });
            return `Error al actualizar: ${e.message}`;
          }
        }
        await this.updateState(phone, { state: "idle", context: {} });
        return "No hay edicion pendiente.";
      } else {
        await this.updateState(phone, { state: "idle", context: {} });
        return "Clave incorrecta. Edicion cancelada.";
      }
    }
    
    // Step 1: Detect edit command
    // Flexible: "reparacion aveo 30k" OR "cambiar reparacion del aveo a 30k" OR "costo reparacion march sense 15000"
    const editFieldMatch = lower.match(/(?:reparaci[o\u00f3]n|rep(?:aracion)?|cmu|precio\s*(?:de\s*)?(?:venta|cmu)|precio\s*aseguradora|costo\s*(?:de\s*)?(?:compra|adquisicion|reparaci[o\u00f3]n)|compra|kit|tanque|gnv)/i);
    // Match value at end, but EXCLUDE years (4 digits starting with 20)
    let editValueMatch = lower.match(/(\d[\d,.]*k)\s*$/i) || lower.match(/(?:a|en)\s+(\d[\d,.]*k?)\b/i);
    if (!editValueMatch) {
      const endNum = lower.match(/(\d[\d,.]*)\s*$/i);
      if (endNum && !/^20[12]\d$/.test(endNum[1])) editValueMatch = endNum;
    }
    
    // If field detected but no value (or value is a year), ask for amount
    if (editFieldMatch && !editValueMatch) {
      // Try to find which vehicle they mean
      const fieldRaw2 = editFieldMatch[0] || "";
      const restOfMsg = lower.slice(lower.indexOf(fieldRaw2) + fieldRaw2.length)
        .replace(/\b(del|de|la|el|a|en|cambiar|editar|ajustar|actualizar|costo|voy|quiero|valor|20[12]\d)\b/gi, "").trim();
      const vehicles2 = await this.storage.listVehicles();
      const match2 = vehicles2.find((v: any) => {
        const fullName = `${v.marca} ${v.modelo} ${v.variante || ""} ${v.anio}`.toLowerCase();
        return restOfMsg.split(/\s+/).some((w: string) => w.length >= 2 && fullName.includes(w));
      });
      if (match2) {
        const vv = match2 as any;
        const fl2 = fieldRaw2.toLowerCase();
        let label2 = "";
        let current2 = 0;
        if (/reparaci|rep/.test(fl2)) { label2 = "Reparacion"; current2 = vv.costo_reparacion || 0; }
        else if (/cmu|precio.*venta/.test(fl2)) { label2 = "PV CMU"; current2 = vv.cmu_valor || 0; }
        else if (/aseguradora|compra|adquisicion/.test(fl2)) { label2 = "Precio compra"; current2 = vv.costo_adquisicion || 0; }
        else if (/kit/.test(fl2)) { label2 = "Kit GNV"; current2 = vv.kit_gnv_costo || 0; }
        else if (/tanque/.test(fl2)) { label2 = "Tanque"; current2 = vv.tanque_costo || 0; }
        return `*${vv.marca} ${vv.modelo} ${vv.variante || ""} ${vv.anio}*\n${label2} actual: $${current2.toLocaleString()}\n\n¿A cuanto lo cambio? (ej: 15k o 15000)`;
      }
    }
    
    if (editFieldMatch && editValueMatch) {
      const fieldRaw = editFieldMatch[0] || "";
      // Extract vehicle hint: everything between field keyword and value
      const afterField = lower.slice(lower.indexOf(fieldRaw) + fieldRaw.length);
      const beforeValue = afterField.slice(0, afterField.lastIndexOf(editValueMatch[1]));
      const vehicleHint = beforeValue.replace(/\b(del|de|la|el|a|en|cambiar|editar|ajustar|actualizar|costo|voy|quiero|valor|quiero\s+cambiar)\b/gi, "").trim();
      const valueStr = editValueMatch[1];
      let value = parseFloat(valueStr.replace(/,/g, "").replace(/k$/i, "")) * (valueStr.toLowerCase().endsWith("k") ? 1000 : 1);
      
      // Find vehicle by name
      const vehicles = await this.storage.listVehicles();
      const match = vehicles.find((v: any) => {
        const fullName = `${v.marca} ${v.modelo} ${v.variante || ""} ${v.anio}`.toLowerCase();
        return vehicleHint.split(/\s+/).every((w: string) => w.length >= 2 && fullName.includes(w));
      });
      
      if (!match) return `No encontre "${vehicleHint}" en inventario. Vehiculos: ${vehicles.map((v: any) => `${v.marca} ${v.modelo} ${v.anio}`).join(", ")}`;
      
      // Map field
      let dbField = "";
      let fieldLabel = "";
      const fl = fieldRaw.toLowerCase();
      if (/reparaci|rep/.test(fl)) { dbField = "costo_reparacion"; fieldLabel = "Reparacion"; }
      else if (/cmu|precio.*venta/.test(fl)) { dbField = "cmu_valor"; fieldLabel = "PV CMU"; }
      else if (/aseguradora|compra|adquisicion/.test(fl)) { dbField = "costo_adquisicion"; fieldLabel = "Precio compra"; }
      else if (/kit/.test(fl)) { dbField = "kit_gnv_costo"; fieldLabel = "Kit GNV"; }
      else if (/tanque/.test(fl)) { dbField = "tanque_costo"; fieldLabel = "Tanque"; }
      else if (/gnv/.test(fl)) { dbField = "kit_gnv_costo"; fieldLabel = "Kit GNV"; }
      
      if (!dbField) return "Campo no reconocido. Usa: reparacion, cmu, compra, kit, tanque.";
      
      const vv = match as any;
      const oldValue = vv[dbField] || 0;
      const description = `- ${fieldLabel}: $${oldValue.toLocaleString()} -> $${value.toLocaleString()}`;
      
      // Save pending edit and ask for PIN
      await this.updateState(phone, {
        state: "awaiting_inventory_pin",
        context: {
          pendingEdit: {
            vehicleId: vv.id,
            fields: { [dbField]: value },
            description,
          }
        }
      });
      
      return `Editar *${vv.marca} ${vv.modelo} ${vv.anio}*:\n${description}\n\nPara confirmar, dime la clave de director:`;
    }

    // ===== MANUAL PAYMENT CONFIRMATION (COB-05) =====
    // Director: "confirmar pago folio 001" or "pago folio 001 3134" or "pago efectivo folio 001 2800"
    const pagoMatch = lower.match(/(?:confirmar\s+)?pago\s+(?:efectivo\s+|spei\s+|transferencia\s+)?(?:folio\s+)?([a-z0-9-]+)\s+(\d[\d,.]*k?)$/i)
      || lower.match(/(?:confirmar\s+pago)\s+(?:folio\s+)?([a-z0-9-]+)$/i);
    if (pagoMatch) {
      const folioHint = pagoMatch[1];
      const montoStr = pagoMatch[2] || "";
      const monto = montoStr ? parseFloat(montoStr.replace(/,/g, "").replace(/k$/i, "")) * (montoStr.toLowerCase().endsWith("k") ? 1000 : 1) : 0;
      const metodo = /efectivo/.test(lower) ? "Efectivo" : /spei|transferencia/.test(lower) ? "SPEI Bancrea" : "Manual";
      
      // Find the folio (partial match)
      const { registrarPago } = await import("./cierre-mensual");
      
      // If no amount, ask for it
      if (!monto) {
        return `Para confirmar el pago de ${folioHint}, dime el monto. Ej: "pago folio ${folioHint} 3134"`;
      }
      
      // Find active cierre for this folio
      const token = process.env.AIRTABLE_PAT;
      if (token) {
        const cierreRes = await fetch(`https://api.airtable.com/v0/appXxbjjGzXFiX7gk/tblVFP0kXEmvD6EZS?filterByFormula=AND(SEARCH("${folioHint.toUpperCase()}",{Folio}),OR({Estatus}="Pendiente Pago",{Estatus}="Mora"))&maxRecords=1`, {
          headers: { "Authorization": `Bearer ${token}` },
        });
        const cierreData = await cierreRes.json();
        const cierre = cierreData.records?.[0];
        if (cierre) {
          const folio = cierre.fields.Folio;
          const mes = cierre.fields.Mes;
          const result = await registrarPago(folio, mes, monto, metodo);
          return result.success 
            ? `Pago registrado: *$${monto.toLocaleString()}* (${metodo}) para ${folio} mes ${mes}. ${result.message}`
            : `Error: ${result.message}`;
        }
        return `No encontre cierre pendiente para "${folioHint}". Verifica el folio.`;
      }
      return "Airtable no configurado.";
    }

    // Folios
    if (lower === "folios") {
      const origs = await this.storage.listOriginations();
      if (!origs.length) return "Sin folios.";
      const lines = [`📁 *FOLIOS* (${origs.length})\n`];
      for (const o of origs.slice(0, 15)) {
        const oo = o as any;
        const docs = await this.storage.getDocumentsByOrigination(oo.id);
        const cap = docs.filter((d: any) => d.imageData || d.image_data).length;
        lines.push(`• ${oo.folio} | ${oo.estado} | Docs: ${cap}/${DOC_ORDER.length}`);
      }
      return lines.join("\n");
    }

    // Cartera (Airtable dashboard)
    // Send message to external contact (director only)
    const sendMsgMatch = cmd.match(/^(?:manda|envia|env[ií]a)\s+(?:mensaje|msg|whatsapp)\s+(?:a\s+)?(?:lilia|natgas|\d{10,13})\s*[:\-]?\s*(.+)/i);
    if (sendMsgMatch) {
      const msgBody = sendMsgMatch[1].trim();
      // For now, only Lilia is supported as external contact
      const liliaPhone = "whatsapp:+524421146330";
      try {
        // Use the internal fetch to call our own send endpoint
        await fetch("http://localhost:5000/api/whatsapp/send-outbound", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: liliaPhone, body: msgBody }),
          signal: AbortSignal.timeout(10000),
        });
        return `Mensaje enviado a Lilia Plata (NATGAS).`;
      } catch (e: any) { return `Error al enviar: ${e.message}`; }
    }

    // Cierre mensual command
    // QW-6: Clear recaudo hash cache to allow reprocessing
    if (lower === "reprocesar recaudo" || lower === "limpiar recaudo") {
      recaudoProcessedHashes.clear();
      return "Cache de recaudo limpiado. Puedes enviar el archivo de nuevo.";
    }

    if (lower === "cierre" || lower === "cierre mensual") {
      try {
        const result = await cierreMensual();
        return formatCierreReport(result);
      } catch (e: any) { return `Error en cierre: ${e.message}`; }
    }

    // Process CSV/Excel (NATGAS recaudo) — multi-product + unified dedup
    if (mediaUrl) {
      try {
        const media = await this.downloadMedia(mediaUrl, mediaType);
        
        if ((media as any)._isCsv && media.pdfText) {
          if (isDuplicateFile(media.pdfText)) {
            return "Este archivo ya fue procesado. Si necesitas reprocesarlo, escribe \"reprocesar recaudo\".";
          }
          const csvRows = parseNatgasCsvRows(media.pdfText);
          const summary = await processNatgasMultiProduct(csvRows);
          markFileProcessed(media.pdfText);
          return formatRecaudoSummary(summary);
        }
        if ((media as any)._isExcel && (media as any)._excelBuffer) {
          const buf = (media as any)._excelBuffer as Buffer;
          if (isDuplicateFile(buf)) {
            return "Este archivo ya fue procesado. Si necesitas reprocesarlo, escribe \"reprocesar recaudo\".";
          }
          const rows = parseNatgasExcel(buf);
          if (rows.length > 0) {
            const summary = await processNatgasMultiProduct(rows);
            markFileProcessed(buf);
            return formatRecaudoSummary(summary);
          }
          return "Excel recibido pero sin datos de CONDUCTORES DEL MUNDO.";
        }
      } catch (e: any) {
        console.error("[Agent] CSV/Excel processing error:", e.message);
      }
    }

    // Genera contrato command
    const contratoMatch = lower.match(/^(?:genera|generar|contrato)\s+(TSR|PAG|CER|CTK|REST|RES|LIQ|ADD-PRO|VAL)(?:\s+(.+))?/i);
    if (contratoMatch) {
      const templateType = contratoMatch[1].toUpperCase();
      const folioHint = contratoMatch[2]?.trim();
      try {
        // Find origination
        let origId: number | null = null;
        if (folioHint) {
          const results = await this.findFolio(folioHint);
          if (results.length === 1) origId = results[0].id;
          else if (results.length > 1) return `${results.length} folios encontrados. Sé más específico.`;
          else return `No encontré folio "${folioHint}".`;
        } else {
          // Use last folio from conversation state
          const convSt = await this.getConvState(phone);
          origId = convSt.folioId;
        }
        if (!origId) return `Necesito el folio. Ejemplo: contrato TSR López`;
        return `Contrato ${templateType} generado. Descárgalo en:\nhttps://cmu-originacion.fly.dev/api/originations/${origId}/contract/v10\n(POST con body: {"templateType":"${templateType}","outputFormat":"pdf"})`;
      } catch (e: any) { return `Error: ${e.message}`; }
    }

    if (lower === "cartera" || lower === "cobranza" || lower === "mora") {
      if (isAirtableEnabled()) {
        try {
          return await buildCarteraDashboard();
        } catch (e: any) {
          return `⚠️ Error al consultar cartera: ${e.message}`;
        }
      }
      return "Cartera no disponible (Airtable no configurado).";
    }

    // Client-specific lookup by name or product keyword for director
    // Matches: "ahorro capetillo", "cuanto lleva obed", "elvira", "joylong", "kit conversion", etc.
    if (isAirtableEnabled()) {
      const knownNames = ["capetillo", "obed", "elvira", "zavala", "mauricio", "hector", "h\u00e9ctor", "manuel", "flores", "l\u00f3pez", "lopez"];
      const isClientQuery = knownNames.some(n => lower.includes(n))
        || /(?:ahorro|joylong|kit|conversi[o\u00f3]n|cu[a\u00e1]nto\s+lleva|cu[a\u00e1]nto\s+debe|estado\s+de|saldo\s+de)/.test(lower);
      
      if (isClientQuery) {
        try {
          console.log(`[Agent] Client lookup triggered for: "${lower}"`);
          const result = await this.lookupClientForDirector(lower);
          console.log(`[Agent] Client lookup result: ${result ? result.slice(0, 80) + '...' : 'null'}`);
          if (result) return result;
        } catch (e: any) {
          console.error("[Agent] Client lookup error:", e.message, e.stack?.slice(0, 200));
        }
      }
    }

    // Nuevo folio from director
    const nuevoFolioMatch = cmd.match(/^nuevo\s+folio\s+(.+)/i);
    if (nuevoFolioMatch) {
      const args = nuevoFolioMatch[1].trim();
      // Expected: "nombre telefono" or just "nombre"
      const phoneMatch = args.match(/(\d{10,13})/);
      const taxistaPhone = phoneMatch ? phoneMatch[1] : "";
      const taxistaName = args.replace(/\d{10,13}/, "").trim() || "Sin nombre";

      if (!taxistaPhone) {
        return "Formato: *nuevo folio [nombre] [teléfono]*\nEjemplo: nuevo folio Juan Pérez 4491234567";
      }
      try {
        const result = await createFolioFromWhatsApp(this.storage, phone, taxistaName, taxistaPhone);
        await this.updateState(phone, {
          folioId: result.originationId,
          state: "capturing_docs",
          context: {
            folio: {
              id: result.originationId,
              folio: result.folio,
              estado: "BORRADOR",
              step: 1,
              docsCapturados: [],
              docsPendientes: DOC_ORDER.map(d => d.key),
              taxistaName,
            },
          },
        });
        return `✅ *Folio creado:* ${result.folio}\n\nTaxista: ${taxistaName}\nTel: ${taxistaPhone}\n\nYa puedes enviar documentos para este folio.\nPrimero: *INE (frente y vuelta)*`;
      } catch (e: any) {
        return `❌ Error al crear folio: ${e.message}`;
      }
    }

    // Corrida — BEFORE wantsPrices so "corrida aveo" doesn't get intercepted
    if (lower.startsWith("corrida")) {
      console.log(`[handleCanalC] CORRIDA handler hit! lower="${lower}"`);
      const rest = lower.replace("corrida", "").trim();
      let model: Model | undefined;
      if (rest) model = await this.resolveModel(rest);
      if (!model) {
        const last = await this.getLastModel(phone);
        if (last && !this.isVirtualModel(last)) model = last as Model;
      }
      if (!model) return "Modelo no encontrado. Uso: corrida march sense";
      const typCost = Math.round(model.cmu * 0.55);
      const input: EvaluationInput = { modelId: model.id, modelSlug: model.slug, year: model.year, cmu: model.cmu, insurerPrice: typCost, repairEstimate: 10000, conTanque: true };
      const r = evaluateOpportunity(input, { brand: model.brand, model: model.model, variant: model.variant, slug: model.slug, purchaseBenchmarkPct: model.purchaseBenchmarkPct }, { gnvRevenue: fuelGnv });
      const cLines = [`*CORRIDA ${model.brand} ${model.model}${model.variant ? " " + model.variant : ""} ${model.year}*`, `CMU: $${model.cmu.toLocaleString()} | Plazos: $${r.ventaPlazos.toLocaleString()}`, `Costo ref: compra $${typCost.toLocaleString()} + rep $10,000 + kit GNV $${r.kitGnv.toLocaleString()} = *$${r.totalCost.toLocaleString()}*`, ``];
      cLines.push(`Mes | Cuota | GNV | Pago ref`);
      for (let i = 0; i < Math.min(6, r.amortizacion.length); i++) {
        const row = r.amortizacion[i];
        cLines.push(`${row.month} | $${row.cuota.toLocaleString()} | -$${fuelGnv.toLocaleString()} | $${Math.max(0, row.cuota - fuelGnv + CMU.fondoMensual).toLocaleString()}`);
      }
      cLines.push(`... (post anticipo $50k mes 2)`);
      for (let i = 2; i < Math.min(5, r.amortizacionConAnticipo.length); i++) {
        const row = r.amortizacionConAnticipo[i];
        cLines.push(`${row.month} | $${row.cuota.toLocaleString()} | -$${fuelGnv.toLocaleString()} | $${Math.max(0, row.cuota - fuelGnv + CMU.fondoMensual).toLocaleString()}`);
      }
      if (r.mesGnvCubre) cLines.push(``, `Mes ${r.mesGnvCubre}+: recaudo GNV iguala cuota, pago neto = solo $${CMU.fondoMensual}/mes (FG)`);
      return cLines.join("\n");
    }

    // Alta / registro de cliente — guide BEFORE hitting LLM
    if (lower.includes("alta") || lower.includes("iniciar proceso") || lower.includes("iniciemos proceso") || lower.includes("registrar cliente") || lower.includes("nuevo cliente") || lower.includes("dar de alta") || lower.includes("proceso de alta")) {
      return "Para dar de alta un cliente necesito:\n\n*nuevo folio [nombre] [telefono]*\n\nEjemplo: nuevo folio Juan P\u00e9rez 4491234567";
    }

    // Mercado / precio / precios — detect ANYWHERE in text (including natural questions)
    const wantsPrices = lower.includes("precio") || lower.includes("mercado") || lower.includes("market") || lower.includes("cu\u00e1nto cuesta") || lower.includes("cuanto cuesta") || lower.includes("cu\u00e1nto vale") || lower.includes("cuanto vale");
    if (wantsPrices) {
      const extracted = this.extractModelFromNaturalText(lower);
      
      if (extracted.modelName) {
        const searchYear = extracted.year || 2024;
        const model = await this.resolveModel(extracted.modelName, extracted.year);
        if (model) {
          await this.setLastModel(phone, model);
          const mktYear = extracted.year || model.year;
          const mkt = await this.fetchMarketPrices(model.brand, model.model, mktYear, model.variant);
          const yearNote = (extracted.year && extracted.year !== model.year) ? `\nNota: en catálogo CMU tenemos ${model.year}, precios de mercado buscados para ${mktYear}.` : "";
          if (mkt.count > 0 && mkt.avg) {
            return [
              `PRECIOS DE MERCADO`,
              `${model.brand} ${model.model} ${model.variant || ""} ${mktYear}`,
              ``, `CMU (precio contado): $${model.cmu.toLocaleString()}${yearNote}`,
              ``, `Mercado (${mkt.count} listings):`,
              `Promedio: $${mkt.avg.toLocaleString()}`,
              `Mediana: $${(mkt.median || 0).toLocaleString()}`,
              `Mínimo: $${(mkt.min || 0).toLocaleString()}`,
              `Máximo: $${(mkt.max || 0).toLocaleString()}`,
              `Fuentes: ${mkt.sources}${mkt.fallback ? " (catálogo, fuentes externas no disponibles)" : ""}`,
              ``, `CMU vs Mercado: ${((model.cmu / mkt.avg) * 100).toFixed(0)}%`,
            ].join("\n");
          }
          return `${model.brand} ${model.model} ${mktYear} -- CMU: $${model.cmu.toLocaleString()}${yearNote}\nNo encontré precios de mercado en este momento.`;
        }
        // NOT in CMU catalog → still search market prices using brand mapping
        const brandFromMap = extracted.brand || WhatsAppAgent.BRAND_MAP[extracted.modelName] || null;
        if (brandFromMap) {
          const modelNameCap = extracted.modelName.charAt(0).toUpperCase() + extracted.modelName.slice(1);
          // v9: Also save as virtual model so we remember it
          const virtualModel = this.buildVirtualModel(brandFromMap, modelNameCap, searchYear);
          await this.setLastModel(phone, virtualModel);
          console.log(`[MarketPrices] Non-catalog search: ${brandFromMap} ${modelNameCap} ${searchYear}`);
          const mkt = await this.fetchMarketPrices(brandFromMap, modelNameCap, searchYear);
          if (mkt.count > 0 && mkt.avg) {
            return [
              `PRECIOS DE MERCADO`,
              `${brandFromMap} ${modelNameCap} ${searchYear}`,
              ``, `(No está en catálogo CMU)`,
              ``, `Mercado (${mkt.count} listings):`,
              `Promedio: $${mkt.avg.toLocaleString()}`,
              `Mediana: $${(mkt.median || 0).toLocaleString()}`,
              `Mínimo: $${(mkt.min || 0).toLocaleString()}`,
              `Máximo: $${(mkt.max || 0).toLocaleString()}`,
              `Fuentes: ${mkt.sources}${mkt.fallback ? " (catálogo)" : ""}`,
            ].join("\n");
          }
          return `${brandFromMap} ${modelNameCap} ${searchYear} -- no encontré precios de mercado en este momento.`;
        }
        // Brand unknown — try raw search anyway
        const rawModel = extracted.modelName.charAt(0).toUpperCase() + extracted.modelName.slice(1);
        console.log(`[MarketPrices] Raw search (no brand): ${rawModel} ${searchYear}`);
        const mkt = await this.fetchMarketPrices("", rawModel, searchYear);
        if (mkt.count > 0 && mkt.avg) {
          return [`PRECIOS DE MERCADO`, `${rawModel} ${searchYear}`, ``, `Mercado (${mkt.count} listings):`, `Promedio: $${mkt.avg.toLocaleString()}`, `Mediana: $${(mkt.median || 0).toLocaleString()}`, `Fuentes: ${mkt.sources}`].join("\n");
        }
        return `No encontré precios de mercado para ${rawModel} ${searchYear}. Intente con marca y modelo: "mercado nissan versa 2023"`;
      }
      
      // No model in text → use lastModel as fallback
      if (!extracted.modelName) {
        const last = await this.getLastModel(phone);
        if (last) {
          const mkt = await this.fetchMarketPrices(last.brand, last.model, last.year, (last as any).variant);
          if (mkt.count > 0 && mkt.avg) {
            return [`PRECIOS DE MERCADO (${last.brand} ${last.model} ${last.year})`, `Promedio: $${mkt.avg.toLocaleString()} | Mediana: $${(mkt.median||0).toLocaleString()} | ${mkt.count} listings`, `Fuentes: ${mkt.sources}`].join("\n");
          }
        }
        return "De que modelo? Ejemplo: mercado versa 2023";
      }
    }

    // Modelos / catálogo
    if (lower === "modelos" || lower === "catálogo" || lower === "catalogo") {
      const models = await this.storage.getModels();
      return `📋 *CATÁLOGO CMU* (${models.length} modelos)\n\n${models.map((m: any) => `• ${m.brand} ${m.model} ${m.variant || ""} ${m.year} — CMU $${m.cmu.toLocaleString()}`).join("\n")}`;
    }

    // Vehicle photo
    if (mediaUrl) {
      let img = "";
      try {
        const SID = process.env.TWILIO_ACCOUNT_SID; const TOK = process.env.TWILIO_AUTH_TOKEN;
        const r = await fetch(mediaUrl, { headers: { "Authorization": "Basic " + Buffer.from(`${SID}:${TOK}`).toString("base64") } });
        const buf = await r.arrayBuffer();
        img = `data:${mediaType || "image/jpeg"};base64,${Buffer.from(buf).toString("base64")}`;
      } catch { return "⚠️ No pude descargar la imagen."; }
      const vehicle = await this.identifyVehicle(img);
      if (vehicle) {
        const model = await this.resolveModel(`${vehicle.model}`, vehicle.year);
        if (model) {
          await this.setLastModel(phone, model);
          return `🚗 *${vehicle.brand} ${vehicle.model} ~${vehicle.year}* ${vehicle.notes}\nCMU en DB: *$${model.cmu.toLocaleString()}*\n\n¿Cuánto piden? ¿Reparación estimada?`;
        }
        // v9: save non-catalog vehicle to state
        const virtualModel = this.buildVirtualModel(vehicle.brand, vehicle.model, vehicle.year);
        await this.setLastModel(phone, virtualModel);
        return `🚗 ${vehicle.brand} ${vehicle.model} ~${vehicle.year} ${vehicle.notes}\nNo tengo CMU en DB para este modelo. ¿Cuánto piden?`;
      }
      return "No identifiqué el vehículo. ¿Marca, modelo y año?";
    }

    // (awaiting_variant moved to handleMessage)
    if (false && convState) { // DISABLED — this runs in handleMessage now
      const pe = convState.context.pendingEval as any;
      const variants: string[] = pe.variants || [];
      const matchedVariant = variants.find((v: string) => lower.includes(v.toLowerCase()));
      if (matchedVariant) {
        // Rebuild the full query and re-evaluate
        const fullQuery = `${pe.modelName} ${matchedVariant} ${pe.year} ${Math.round(pe.cost/1000)}k rep ${Math.round(pe.repair/1000)}k`;
        console.log(`[Agent] Variant selected: ${matchedVariant}, rebuilding eval: ${fullQuery}`);
        await this.updateState(phone, { state: "idle", context: {} });
        const model = await this.resolveModel(`${pe.modelName} ${matchedVariant}`, pe.year);
        if (model) {
          await this.setLastModel(phone, model);
          const fuel = await this.getFuel();
          const mkt = await this.fetchMarketPrices(model.brand, model.model, model.year, model.variant);
          const mData = { brand: model.brand, model: model.model, variant: model.variant, slug: model.slug, purchaseBenchmarkPct: model.purchaseBenchmarkPct };
          const input: EvaluationInput = { modelId: model.id, modelSlug: model.slug, year: model.year, cmu: model.cmu, insurerPrice: pe.cost, repairEstimate: pe.repair, conTanque: pe.conTanque ?? true };
          const rules = await this.getRules();
          const result = evaluateOpportunity(input, mData, { gnvRevenue: fuel.gnvRevenueMes, marketAvgPrice: mkt.avg });
          return this.formatEvalResult(result, mkt, fuel.gnvRevenueMes, getThresholds(rules));
        }
        // Model+variant not found in catalog → market-based (same flow as non-catalog)
        const brandFromMap = WhatsAppAgent.BRAND_MAP[(pe.modelName || "").toLowerCase()] || null;
        if (brandFromMap) {
          const mkt = await this.fetchMarketPrices(brandFromMap, `${pe.modelName} ${matchedVariant}`, pe.year);
          if (mkt.count > 0 && mkt.avg) {
            const marketCmu = Math.round(mkt.avg * 0.95 / 1000) * 1000;
            const slug = `${brandFromMap}-${pe.modelName}-${matchedVariant}`.toLowerCase().replace(/\s+/g, "-");
            const mData = { brand: brandFromMap, model: `${pe.modelName} ${matchedVariant}`, variant: null as string | null, slug, purchaseBenchmarkPct: 0.65 };
            const input: EvaluationInput = { modelId: 0, modelSlug: slug, year: pe.year, cmu: marketCmu, insurerPrice: pe.cost, repairEstimate: pe.repair, conTanque: pe.conTanque ?? true };
            const fuel = await this.getFuel();
            const rules = await this.getRules();
            const result = evaluateOpportunity(input, mData, { gnvRevenue: fuel.gnvRevenueMes, marketAvgPrice: mkt.avg });
            await this.autoInsertCatalogModel(brandFromMap, pe.modelName, matchedVariant, pe.year, marketCmu);
            return `\u26a0\ufe0f *No est\u00e1 en cat\u00e1logo CMU* \u2014 usando precio de mercado\nPV = mercado $${mkt.avg.toLocaleString()} \u00d7 0.95 = *$${marketCmu.toLocaleString()}*\n\n` + this.formatEvalResult(result, mkt, fuel.gnvRevenueMes, getThresholds(rules));
          }
        }
        return `No encontr\u00e9 ${pe.modelName} ${matchedVariant} ${pe.year} en mercado. Intenta con el nombre completo.`;
      }
      // Didn't match a variant — clear state and continue normal flow
      await this.updateState(phone, { state: "idle", context: {} });
    }

    // ===== EVALUATION always runs first if there are eval signals, even in conversational text =====
    const earlyParsed = this.parseEvalLine(cmd);
    const earlyEvalSignals = earlyParsed.cost || earlyParsed.repair || lower.startsWith("evalua") || lower.startsWith("eval\u00faa");
    
    if (earlyEvalSignals) {
      let model: Model | undefined;
      if (earlyParsed.modelQuery) model = await this.resolveModel(earlyParsed.modelQuery, earlyParsed.year);

      // v11: Variant disambiguation — check even when model IS found (e.g. "march 2021" → Sense or Advance?) → ask
      if (earlyParsed.modelQuery && earlyParsed.cost) {
        const queryLower = (earlyParsed.modelQuery || "").toLowerCase();
        const hasVariantInQuery = queryLower.includes("sense") || queryLower.includes("advance") ||
          queryLower.includes("sedan") || queryLower.includes("hatchback");
        if (!hasVariantInQuery) {
          const extracted = this.extractModelFromNaturalText(earlyParsed.modelQuery);
          const checkName = model ? model.model : extracted.modelName;
          if (checkName) {
            const variants = await this.getVariantsForModel(checkName);
            if (variants.length > 1) {
              const yr = earlyParsed.year || (model ? model.year : 2024);
              // Save pending eval so bare variant answer reconnects
              await this.updateState(phone, {
                state: "awaiting_variant",
                context: {
                  pendingEval: {
                    modelName: checkName,
                    year: yr,
                    cost: earlyParsed.cost,
                    repair: earlyParsed.repair || 10000,
                    conTanque: earlyParsed.conTanque,
                    variants,
                  },
                },
              });
              return `\u00bfQu\u00e9 variante de ${checkName} ${yr}?\n${variants.map(v => `- *${checkName} ${v}*`).join("\n")}\n\nEjemplo: ${checkName} ${variants[0]} ${yr} ${Math.round((earlyParsed.cost||0)/1000)}k rep ${Math.round((earlyParsed.repair||10000)/1000)}k`;
            }
          }
        }
      }
      
      if (!model) {
        const last = await this.getLastModel(phone);
        // ONLY use lastModel if user did NOT mention a model name in this message
        if (last && !this.isVirtualModel(last) && !earlyParsed.modelQuery) model = last as Model;
      }

      if (model && earlyParsed.cost) {
        await this.setLastModel(phone, model);
        await this.updateState(phone, {
          state: "evaluating",
          context: {
            vehicle: { brand: model.brand, model: model.model, variant: model.variant, year: model.year, cmu: model.cmu, inCatalog: true },
            eval: { cost: earlyParsed.cost, repair: earlyParsed.repair || 10000, conTanque: earlyParsed.conTanque },
          },
        });
        const fuel = await this.getFuel();
        const mkt = await this.fetchMarketPrices(model.brand, model.model, model.year, model.variant);
        // Validate market data: if <5 samples or >20% deviation from catalog, don't use for PV rule
        let validMarketAvg: number | null = mkt.avg;
        if (mkt.avg && model.cmu > 0) {
          const ratio = mkt.avg / model.cmu;
          if (mkt.count < 5 || ratio > 1.20 || ratio < 0.80) {
            console.log(`[Eval] Market data unreliable: ${mkt.count} samples, ratio=${ratio.toFixed(2)} — using catalog CMU $${model.cmu}`);
            validMarketAvg = null;
          }
        }
        const m = model as any;
        const mData = { brand: m.brand, model: m.model, variant: m.variant, slug: m.slug, purchaseBenchmarkPct: m.purchaseBenchmarkPct || m.purchase_benchmark_pct || 0.60 };
        const input: EvaluationInput = { modelId: m.id, modelSlug: m.slug, year: m.year, cmu: m.cmu, insurerPrice: earlyParsed.cost, repairEstimate: earlyParsed.repair || 10000, conTanque: earlyParsed.conTanque };
        const rules = await this.getRules();
        const result = evaluateOpportunity(input, mData, { gnvRevenue: fuel.gnvRevenueMes, marketAvgPrice: validMarketAvg });
        return this.formatEvalResult(result, mkt, fuel.gnvRevenueMes, getThresholds(rules));
      }
      if (model && !earlyParsed.cost) return `${model.brand} ${model.model} ${model.variant || ""} ${model.year}\nCMU: $${model.cmu.toLocaleString()}\n\nCosto de adquisicion?`;
      
      // v11: Model NOT in catalog but cost given → use market prices to build virtual evaluation
      if (!model && earlyParsed.cost) {
        const extracted = this.extractModelFromNaturalText(earlyParsed.modelQuery || cmd);
        const brandFromMap = extracted.brand || WhatsAppAgent.BRAND_MAP[extracted.modelName || ""] || null;
        const modelName = extracted.modelName ? extracted.modelName.charAt(0).toUpperCase() + extracted.modelName.slice(1) : null;
        const searchYear = earlyParsed.year || extracted.year || 2024;
        
        if (brandFromMap && modelName) {
          // Fetch market prices
          const mkt = await this.fetchMarketPrices(brandFromMap, modelName, searchYear);
          if (mkt.count > 0 && mkt.avg) {
            // PV = market * 0.95
            const marketCmu = Math.round(mkt.avg * 0.95 / 1000) * 1000;
            console.log(`[Eval] Non-catalog: ${brandFromMap} ${modelName} ${searchYear}, market avg=$${mkt.avg}, PV=$${marketCmu}`);
            
            // Build virtual model data for evaluation
            const slug = `${brandFromMap}-${modelName}`.toLowerCase().replace(/\s+/g, "-");
            const mData = { brand: brandFromMap, model: modelName, variant: null as string | null, slug, purchaseBenchmarkPct: 0.65 };
            const input: EvaluationInput = { modelId: 0, modelSlug: slug, year: searchYear, cmu: marketCmu, insurerPrice: earlyParsed.cost, repairEstimate: earlyParsed.repair || 10000, conTanque: earlyParsed.conTanque };
            const fuel = await this.getFuel();
            const rules = await this.getRules();
            const result = evaluateOpportunity(input, mData, { gnvRevenue: fuel.gnvRevenueMes, marketAvgPrice: mkt.avg });
            
            // Auto-insert into catalog for future lookups
            await this.autoInsertCatalogModel(brandFromMap, modelName, null, searchYear, marketCmu);
            
            // Save as lastModel
            const virtualModel = this.buildVirtualModel(brandFromMap, modelName, searchYear);
            (virtualModel as any).cmu = marketCmu;
            await this.setLastModel(phone, virtualModel);
            
            return `⚠️ *No está en catálogo CMU* — usando precio de mercado como referencia\nPV = mercado $${mkt.avg.toLocaleString()} \u00d7 0.95 = *$${marketCmu.toLocaleString()}*\n\n` + this.formatEvalResult(result, mkt, fuel.gnvRevenueMes, getThresholds(rules));
          }
          return `${brandFromMap} ${modelName} ${searchYear} — no encontr\u00e9 precios de mercado. No puedo evaluar sin referencia de precio.\n\nIntenta con un modelo del cat\u00e1logo: *modelos*`;
        }
        return "Necesito el modelo. Ejemplo: aveo 130k rep 25k\nO escribe *modelos* para ver el cat\u00e1logo.";
      }
    }

    // From here: only structured commands or conversation
    if (this.isConversational(cmd)) {
      // Jump to LLM fallback at the end
    } else {

    // Batch evaluation (multiple lines)
    const lines = cmd.split("\n").map(l => l.trim()).filter(l => l.length > 3);
    const looksLikeBatch = lines.length > 1 && lines.some(l => /\d{2,3}\s*k|rep/i.test(l));
    if (looksLikeBatch) {
      const results: { line: string; result: EvaluationResult | null }[] = [];
      for (const line of lines) {
        const p = this.parseEvalLine(line);
        if (!p.modelQuery || !p.cost) { results.push({ line, result: null }); continue; }
        const model = await this.resolveModel(p.modelQuery, p.year);
        if (!model) { results.push({ line, result: null }); continue; }
        const input: EvaluationInput = { modelId: model.id, modelSlug: model.slug, year: model.year, cmu: model.cmu, insurerPrice: p.cost, repairEstimate: p.repair || 10000, conTanque: p.conTanque };
        try {
          const r = evaluateOpportunity(input, { brand: model.brand, model: model.model, variant: model.variant, slug: model.slug, purchaseBenchmarkPct: model.purchaseBenchmarkPct }, { gnvRevenue: fuelGnv });
          results.push({ line, result: r });
        } catch { results.push({ line, result: null }); }
      }
      const valid = results.filter(r => r.result);
      if (!valid.length) return "No pude evaluar. Formato: [modelo] [costo]k rep [rep]";
      const rows = valid.map(v => {
        const r = v.result!;
        let e = "✅"; if (r.costoPctCmu >= 0.90) e = "❌"; else if (r.costoPctCmu >= 0.80) e = "⚠️";
        return `${e} ${r.model}${r.variant ? " " + r.variant : ""} ${r.year} | $${(r.totalCost / 1000).toFixed(0)}k | $${(r.margin / 1000).toFixed(0)}k | ${(r.costoPctCmu * 100).toFixed(0)}% | TIR ${(r.tirBase * 100).toFixed(0)}%`;
      });
      const best = valid.reduce((a, b) => (a.result!.tirBase > b.result!.tirBase ? a : b));
      return [`📊 *COMPARATIVA* (${valid.length})\n`, `Veh | Costo | Margen | %CMU | TIR`, ...rows, ``, `🏆 ${best.result!.model} ${best.result!.year} (TIR ${(best.result!.tirBase * 100).toFixed(0)}%)`].join("\n");
    }

    // Single evaluation (non-early — from structured commands)
    const parsed = this.parseEvalLine(cmd);
    const hasEvalSignals = parsed.cost || parsed.repair
      || lower.startsWith("evalua") || lower.startsWith("evalúa");
    
    if (hasEvalSignals) {
      let model: Model | undefined;
      if (parsed.modelQuery) {
        model = await this.resolveModel(parsed.modelQuery, parsed.year);
      }
      if (!model) {
        const last = await this.getLastModel(phone);
        // ONLY use lastModel if user did NOT mention a model name in this message
        if (last && !this.isVirtualModel(last) && !parsed.modelQuery) model = last as Model;
      }
      if (!model) {
        return "Necesito el modelo del vehiculo. Ejemplo: aveo 110k rep 10k";
      }
      await this.setLastModel(phone, model);
      if (!parsed.cost) return `${model.brand} ${model.model} ${model.variant || ""} ${model.year}\nCMU: $${model.cmu.toLocaleString()}\n\nCosto de adquisicion?`;
      const fuel2 = await this.getFuel();
      const mkt2 = await this.fetchMarketPrices(model.brand, model.model, model.year, model.variant);
      const input: EvaluationInput = { modelId: model.id, modelSlug: model.slug, year: model.year, cmu: model.cmu, insurerPrice: parsed.cost, repairEstimate: parsed.repair || 10000, conTanque: parsed.conTanque };
      const rules2 = await this.getRules();
      const result = evaluateOpportunity(input, { brand: model.brand, model: model.model, variant: model.variant, slug: model.slug, purchaseBenchmarkPct: model.purchaseBenchmarkPct }, { gnvRevenue: fuel2.gnvRevenueMes, marketAvgPrice: mkt2.avg });
      return this.formatEvalResult(result, mkt2, fuel2.gnvRevenueMes, getThresholds(rules2));
    }

    // If just a known model name (short, 1-4 words, no question), show CMU info + market prices
    if (parsed.modelQuery && !hasEvalSignals && cmd.split(/\s+/).length <= 4) {
      const extracted = this.extractModelFromNaturalText(lower);
      const model = await this.resolveModel(parsed.modelQuery, parsed.year);
      if (model) {
        await this.setLastModel(phone, model);
        const searchYear = parsed.year || model.year;
        const mkt = await this.fetchMarketPrices(model.brand, model.model, searchYear, model.variant);
        const mktLine = (mkt.count > 0 && mkt.avg)
          ? `Mercado: $${(mkt.min||0).toLocaleString()}-$${(mkt.max||0).toLocaleString()} (promedio $${mkt.avg.toLocaleString()}, ${mkt.count} listings)`
          : "";
        return [
          `${model.brand} ${model.model} ${model.variant || ""} ${searchYear}`,
          `CMU: $${model.cmu.toLocaleString()}`,
          mktLine,
          ``,
          `Dame costo de adquisicion y reparacion para evaluar.`,
        ].filter(Boolean).join("\n");
      }
      // Not in catalog but we can still search market
      if (extracted.modelName && extracted.brand) {
        const modelCap = extracted.modelName.charAt(0).toUpperCase() + extracted.modelName.slice(1);
        const searchYear = extracted.year || parsed.year || 2024;
        // v9: Save as virtual model
        const virtualModel = this.buildVirtualModel(extracted.brand, modelCap, searchYear);
        await this.setLastModel(phone, virtualModel);
        const mkt = await this.fetchMarketPrices(extracted.brand, modelCap, searchYear);
        if (mkt.count > 0 && mkt.avg) {
          return [
            `PRECIOS DE MERCADO`,
            `${extracted.brand} ${modelCap} ${searchYear}`,
            `(No está en catálogo CMU)`,
            ``, `Promedio: $${mkt.avg.toLocaleString()}`,
            `Mediana: $${(mkt.median || 0).toLocaleString()}`,
            `Rango: $${(mkt.min || 0).toLocaleString()} - $${(mkt.max || 0).toLocaleString()}`,
            `Fuentes: ${mkt.sources}`,
          ].join("\n");
        }
        return `${extracted.brand} ${modelCap} ${searchYear} -- no está en catálogo CMU y no encontré precios de mercado.`;
      }
    }

    // (corrida and alta handlers moved earlier in the flow)

    } // end of !isConversational block

    // LLM fallback for conversation / complex queries
    const models = await this.storage.getModels();
    const modelList = models.map((m: any) => `${m.brand} ${m.model} ${m.variant || ""} ${m.year} -- CMU $${m.cmu.toLocaleString()}`).join("\n");
    const origs = await this.storage.listOriginations();
    const vehicles = await this.storage.listVehicles();
    const ctx = `Folios activos: ${origs.length} | Vehiculos en flota: ${vehicles.length} | Disponibles: ${vehicles.filter((v: any) => v.status === "disponible").length}`;
    const lastModel = await this.getLastModel(phone);
    const lastModelCtx = lastModel ? `Ultimo modelo discutido: ${lastModel.brand} ${lastModel.model} ${(lastModel as any).variant || ""} ${lastModel.year}${!this.isVirtualModel(lastModel) ? ` (CMU $${(lastModel as Model).cmu.toLocaleString()})` : " (no está en catálogo CMU)"}. Si el usuario da datos sin mencionar modelo, asumir este.` : "Sin modelo previo en la conversacion.";
    const rulesForPrompt = await this.getRules();
    const rulesCtx = buildRulesContext(rulesForPrompt);
    const knowledgeC = buildKnowledgeBase(rulesForPrompt);
    // v9: Add state context + cartera dashboard to LLM prompt
    const convState = await this.getConvState(phone);
    const stateCtx = buildStateContext(convState);
    let carteraDirector = "";
    if (isAirtableEnabled()) {
      try {
        carteraDirector = "\n" + await buildCarteraDashboard();
      } catch (e: any) { console.error("[Agent] Airtable dashboard error:", e.message); }
    }
    const sys = SYSTEM_PROMPT_C
      .replace("{knowledgeBase}", knowledgeC)
      .replace("{evalData}", "")
      .replace("{context}", ctx + carteraDirector)
      .replace("{modelos}", modelList)
      .replace("{lastModelContext}", lastModelCtx)
      .replace("{rulesContext}", rulesCtx)
      .replace("{stateContext}", stateCtx);
    const history = this.getHistoryForLLM(phone, 10);
    const messages: any[] = [{ role: "system", content: sys }, ...history, { role: "user", content: body }];
    return await this.llm(messages);
  }

  // ===== Client lookup for director queries =====
  private async lookupClientForDirector(query: string): Promise<string | null> {
    const BASE = "appXxbjjGzXFiX7gk";
    const TABLE_AHORRO = "tblUjkOQ2rWvBRRmw";
    const TABLE_KIT = "tbletXmlYRwisBcaO";
    const token = process.env.AIRTABLE_PAT;
    if (!token) return null;

    const fetchTable = async (tableId: string): Promise<any[]> => {
      try {
        const res = await fetch(`https://api.airtable.com/v0/${BASE}/${tableId}`, {
          headers: { "Authorization": `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.records || []).map((r: any) => ({ id: r.id, ...r.fields }));
      } catch { return []; }
    };

    const lower = query.toLowerCase();

    // If asking about all ahorro/joylong clients
    if (/(?:joylong|ahorro|todos|clientes|cu[a\u00e1]nto\s+llevan)/.test(lower) && !/capetillo|obed|elvira|zavala|manuel|mauricio|hector|h\u00e9ctor|flores|l\u00f3pez|lopez/.test(lower)) {
      const joylong = await fetchTable(TABLE_AHORRO);
      if (joylong.length === 0) return null;
      const lines = ["*AHORRO JOYLONG*"];
      for (const j of joylong) {
        const ahorro = j["Ahorro Acumulado"] || 0;
        const precio = j["Precio Vehiculo"] || 799000;
        const gatillo = j.Gatillo || 399500;
        const pct = ((ahorro / precio) * 100).toFixed(1);
        const falta = Math.max(0, gatillo - ahorro);
        lines.push(`\n*${j.Cliente}* (${j.Folio})`);
        lines.push(`- Ahorro: $${ahorro.toLocaleString()} (${pct}%)`);
        lines.push(`- Falta p/gatillo: $${falta.toLocaleString()}`);
      }
      return lines.join("\n");
    }

    // Search for specific client by name
    const allRecords: Array<{ record: any; producto: string }> = [];
    const joylong = await fetchTable(TABLE_AHORRO);
    for (const j of joylong) allRecords.push({ record: j, producto: "Joylong Ahorro" });
    const kits = await fetchTable(TABLE_KIT);
    for (const k of kits) allRecords.push({ record: k, producto: "Kit Conversi\u00f3n" });

    // Match by partial name
    const matches = allRecords.filter(r => {
      const name = (r.record.Cliente || "").toLowerCase();
      // Check each word in the query against client name
      const queryWords = lower.replace(/ahorro|joylong|kit|conversi[o\u00f3]n|cu[a\u00e1]nto|lleva|debe|saldo|estado|cuenta|de|el|la|los|las|va|como|c[o\u00f3]mo/gi, "").trim().split(/\s+/);
      return queryWords.some(w => w.length >= 3 && name.includes(w));
    });

    if (matches.length === 0) return null;

    const lines: string[] = [];
    for (const m of matches) {
      const r = m.record;
      if (m.producto === "Joylong Ahorro") {
        const ahorro = r["Ahorro Acumulado"] || 0;
        const precio = r["Precio Vehiculo"] || 799000;
        const gatillo = r.Gatillo || 399500;
        const pct = ((ahorro / precio) * 100).toFixed(1);
        const falta = Math.max(0, gatillo - ahorro);
        lines.push(`*${r.Cliente}* (${r.Folio}) - Joylong Ahorro`);
        lines.push(`- Ahorro acumulado: *$${ahorro.toLocaleString()}* (${pct}% de $${precio.toLocaleString()})`);
        lines.push(`- Falta para gatillo: $${falta.toLocaleString()}`);
        lines.push(`- Estatus: ${r.Estatus}`);
      } else if (m.producto === "Kit Conversi\u00f3n") {
        const saldo = r["Saldo Pendiente"] || 0;
        const precio = r["Precio Kit"] || 55500;
        const pagado = precio - saldo;
        const mes = r["Mes Actual"] || 1;
        const total = r.Parcialidades || 12;
        lines.push(`*${r.Cliente}* (${r.Folio}) - Kit Conversi\u00f3n`);
        lines.push(`- Pagado: *$${pagado.toLocaleString()}* de $${precio.toLocaleString()}`);
        lines.push(`- Saldo pendiente: $${saldo.toLocaleString()}`);
        lines.push(`- Mes ${mes} de ${total}`);
        lines.push(`- Estatus: ${r.Estatus}`);
      }
    }

    return lines.join("\n");
  }

  // ===== Simulation for Canal A (taxista) =====
  private async simulateForTaxista(vehicleQuery: string, leqMes: number): Promise<string | null> {
    const model = await this.resolveModel(vehicleQuery);
    if (!model) return null;
    const fuel = await this.getFuel();
    const typCost = Math.round(model.cmu * 0.55);
    const input: EvaluationInput = { modelId: model.id, modelSlug: model.slug, year: model.year, cmu: model.cmu, insurerPrice: typCost, repairEstimate: 10000, conTanque: true };
    const r = evaluateOpportunity(input, { brand: model.brand, model: model.model, variant: model.variant, slug: model.slug, purchaseBenchmarkPct: model.purchaseBenchmarkPct }, { gnvRevenue: fuel.gnvRevenueMes });
    const recaudo = leqMes * fuel.gnvPrecioLeq;
    const cuotaM1 = r.amortizacion[0]?.cuota || 0;
    const cuotaM3 = r.amortizacionConAnticipo[0]?.cuota || 0;
    const pagoM1 = Math.max(0, cuotaM1 - recaudo) + CMU.fondoMensual;
    const pagoM3 = Math.max(0, cuotaM3 - recaudo) + CMU.fondoMensual;
    return [
      `🚗 *Corrida ${model.brand} ${model.model} ${model.year}* (${leqMes} LEQ/mes)`,
      `Contado: $${model.cmu.toLocaleString()} | Plazos: $${r.ventaPlazos.toLocaleString()}`,
      `Recaudo GNV: ${leqMes} × $${fuel.gnvPrecioLeq.toFixed(2)} = *$${recaudo.toLocaleString()}/mes*`,
      `📅 Mes 1-2: *$${pagoM1.toLocaleString()}/mes*`,
      `📅 Mes 3+: *$${pagoM3.toLocaleString()}/mes*`,
      r.mesGnvCubre ? `A partir del mes ${r.mesGnvCubre}: el recaudo GNV iguala la cuota, tu pago neto baja a *$${CMU.fondoMensual}/mes* (solo Fondo de Garant\u00eda)` : "",
      `FG: $${CMU.fondoInicial.toLocaleString()} + $${CMU.fondoMensual}/mes`,
    ].filter(Boolean).join("\n");
  }

  // ===== MAIN HANDLER =====
  async handleMessage(
    phone: string, body: string, profileName: string,
    mediaUrl: string | null, mediaType: string | null,
    originationId: number | null,
    role: string = "prospecto", roleName: string | null = null, permissions: string[] = [],
  ): Promise<{ reply: string; newOriginationId: number | null; documentSaved: string | null }> {

    // ===== Record user message in conversation history =====
    this.recordMessage(phone, "user", body || "(imagen)");

    // ===== LOAD FUEL PRICES from DB =====
    const fuelPrices = await this.storage.getFuelPrices();
    const fuel = calcFuelContext(fuelPrices);

    // ===== LOAD CLIENT STATE from DB (persistent across sessions) =====
    let clientState = await this.storage.getClientStateByPhone(phone);
    if (clientState && clientState.found && !originationId) {
      originationId = clientState.originationId;
      console.log(`[Agent] Client state loaded for ${phone}: folio=${clientState.folio}, docs=${clientState.docsCapturados.length}/${clientState.totalDocs}`);
    }

    // ===== LOAD CONVERSATION STATE from DB =====
    const convState = await this.getConvState(phone);

    // v9: Use folioId from conversation state if not set from phone_folio
    if (!originationId && convState.folioId) {
      originationId = convState.folioId;
      console.log(`[Agent] Folio from conversation state: ${originationId}`);
    }

    // Helper: record assistant reply before returning
    const respond = async (reply: string, newOid: number | null = originationId, docSaved: string | null = null) => {
      this.recordMessage(phone, "assistant", reply);
      return { reply, newOriginationId: newOid, documentSaved: docSaved };
    };

    // ===== AWAITING VARIANT: reconnect bare variant answer with pending eval =====
    if (convState.state === "awaiting_variant" && convState.context.pendingEval && body) {
      const pe = convState.context.pendingEval as any;
      const variants: string[] = pe.variants || [];
      const lower2 = body.toLowerCase().trim();
      const matchedVariant = variants.find((v: string) => lower2.includes(v.toLowerCase()));
      if (matchedVariant) {
        console.log(`[Agent] Variant selected: ${matchedVariant} for ${pe.modelName} ${pe.year}`);
        await this.updateState(phone, { state: "idle", context: {} });
        
        // Try multiple resolution strategies
        let model = await this.resolveModel(`${pe.modelName} ${matchedVariant}`, pe.year);
        if (!model) model = await this.resolveModel(`${pe.modelName}${matchedVariant}`, pe.year);
        if (!model) model = await this.resolveModel(`${matchedVariant}`, pe.year);
        // Last resort: direct query all models and filter
        if (!model) {
          try {
            const allModels = await this.storage.getModels();
            model = allModels.find((m: any) => {
              const mName = (m.model || "").toLowerCase();
              const mVar = (m.variant || "").toLowerCase();
              const mYear = m.year;
              return (mName.includes(pe.modelName.toLowerCase()) || pe.modelName.toLowerCase().includes(mName))
                && mVar.includes(matchedVariant.toLowerCase())
                && mYear === pe.year;
            }) as any;
          } catch {}
        }
        console.log(`[Agent] resolveModel(${pe.modelName} ${matchedVariant} ${pe.year}): ${model ? `FOUND ${(model as any).brand} ${(model as any).model} ${(model as any).variant} ${(model as any).year} CMU=$${(model as any).cmu}` : "NOT FOUND"}`);
        
        if (model) {
          await this.setLastModel(phone, model);
          const fuel = await this.getFuel();
          // Market prices are optional — evaluation works with catalog CMU alone
          const mkt = await this.fetchMarketPrices(model.brand, model.model, model.year, model.variant).catch(() => ({ count: 0, avg: null as number | null, min: null, max: null, median: null }));
          const m = model as any;
          const mData = { brand: m.brand, model: m.model, variant: m.variant, slug: m.slug, purchaseBenchmarkPct: m.purchaseBenchmarkPct || m.purchase_benchmark_pct || 0.60 };
          const input: EvaluationInput = { modelId: m.id, modelSlug: m.slug, year: m.year, cmu: m.cmu, insurerPrice: pe.cost, repairEstimate: pe.repair, conTanque: pe.conTanque ?? true };
          const rules = await this.getRules();
          const result = evaluateOpportunity(input, mData, { gnvRevenue: fuel.gnvRevenueMes, marketAvgPrice: mkt.avg });
          return await respond(this.formatEvalResult(result, mkt, fuel.gnvRevenueMes, getThresholds(rules)));
        }
        // Not in catalog for that year → try market-based
        const brandFromMap = WhatsAppAgent.BRAND_MAP[(pe.modelName || "").toLowerCase()] || null;
        if (brandFromMap) {
          const searchName = `${pe.modelName} ${matchedVariant}`;
          const mkt = await this.fetchMarketPrices(brandFromMap, searchName, pe.year).catch(() => ({ count: 0, avg: null as number | null, min: null, max: null, median: null }));
          if (mkt.count > 0 && mkt.avg) {
            const marketCmu = Math.round(mkt.avg * 0.95 / 1000) * 1000;
            const slug = `${brandFromMap}-${pe.modelName}-${matchedVariant}`.toLowerCase().replace(/\s+/g, "-");
            const mData = { brand: brandFromMap, model: searchName, variant: null as string | null, slug, purchaseBenchmarkPct: 0.65 };
            const input: EvaluationInput = { modelId: 0, modelSlug: slug, year: pe.year, cmu: marketCmu, insurerPrice: pe.cost, repairEstimate: pe.repair, conTanque: pe.conTanque ?? true };
            const fuel = await this.getFuel();
            const rules = await this.getRules();
            const result = evaluateOpportunity(input, mData, { gnvRevenue: fuel.gnvRevenueMes, marketAvgPrice: mkt.avg });
            await this.autoInsertCatalogModel(brandFromMap, pe.modelName, matchedVariant, pe.year, marketCmu);
            return await respond(`\u26a0\ufe0f *No est\u00e1 en cat\u00e1logo CMU* \u2014 usando precio de mercado\nPV = mercado $${mkt.avg.toLocaleString()} \u00d7 0.95 = *$${marketCmu.toLocaleString()}*\n\n` + this.formatEvalResult(result, mkt, fuel.gnvRevenueMes, getThresholds(rules)));
          }
        }
        await this.updateState(phone, { state: "idle", context: {} });
        return await respond(`No encontr\u00e9 ${pe.modelName} ${matchedVariant} ${pe.year} en cat\u00e1logo ni mercado. Intenta: *march sense 2024 165k rep 20k*`);
      }
      // User said something that doesn't match a variant — clear state
      await this.updateState(phone, { state: "idle", context: {} });
    }

    // ===== SMART GREETINGS + HELP MENU PER ROLE =====
    const isGreeting = /^(hola|hey|buenos? d[ií]as?|buenas? tardes?|buenas? noches?|buenas|qu[eé] tal|saludos|ey|hi|hello|mande)\s*[!.?]*$/i.test(body.trim());
    const isHelp = /^(ayuda|gu[ií]a|men[uú]|menu|comandos|que puedo hacer|qu[eé] puedo hacer|opciones|help)\s*[!.?]*$/i.test(body.trim());
    if ((isGreeting || isHelp) && !mediaUrl) {
      const hour = new Date().getHours();
      const timeGreet = hour < 12 ? "Buenos días" : hour < 18 ? "Buenas tardes" : "Buenas noches";
      const name = roleName || profileName || "";
      
      if (role === "director") {
        return await respond(`${timeGreet} ${name}. \u00bfEn qu\u00e9 te ayudo?\n\nComandos r\u00e1pidos:\n\u2022 *n\u00fameros* \u2014 dashboard KPIs\n\u2022 *inventario* \u2014 veh\u00edculos disponibles\n\u2022 *folios* \u2014 expedientes activos\n\u2022 *cartera* \u2014 cr\u00e9ditos y mora\n\u2022 *mercado [marca modelo a\u00f1o]* \u2014 precios\n\u2022 *[precio]k rep [rep]k* \u2014 evaluaci\u00f3n r\u00e1pida\n\u2022 *corrida [modelo]* \u2014 simulaci\u00f3n financiera\n\u2022 *nuevo folio [nombre] [tel]* \u2014 crear folio\n\u2022 *cierre* \u2014 cierre mensual\n\u2022 Enviar CSV/Excel \u2014 procesar recaudo`);
      }
      if (role === "promotora") {
        const origs = await this.storage.listOriginations();
        const activos = origs.filter((o: any) => !["RECHAZADO", "COMPLETADO"].includes(o.estado));
        return await respond(`${timeGreet} ${name}. Tienes *${activos.length} folios activos*.\n\nComandos r\u00e1pidos:\n\u2022 *folios* \u2014 ver mis folios\n\u2022 *nuevo folio [nombre] [tel]* \u2014 crear folio\n\u2022 *status* \u2014 pendientes del folio actual\n\u2022 Enviar foto de documento \u2014 captura OCR\n\u2022 *[nombre taxista]* \u2014 buscar folio\n\n\u00bfCon qu\u00e9 folio trabajamos hoy?`);
      }
      if (role === "cliente") {
        // Multi-product greeting
        const products = isAirtableEnabled() ? await findProductsByPhone(phone) : [];
        if (products.length > 0) {
          const greetLines: string[] = [`${timeGreet} ${name}.`];
          for (const p of products) {
            if (p.producto === "Joylong Ahorro") {
              const ahorro = p.record["Ahorro Acumulado"] || 0;
              const precio = p.record["Precio Vehiculo"] || 799000;
              const pct = ((ahorro / precio) * 100).toFixed(1);
              greetLines.push(`Tu ahorro Joylong (${p.folio}): *$${ahorro.toLocaleString()}* (${pct}% de $${precio.toLocaleString()}).`);
            } else if (p.producto === "Kit Conversi\u00f3n") {
              const saldo = p.record["Saldo Pendiente"] || 0;
              const mes = p.record["Mes Actual"] || 1;
              const total = p.record["Parcialidades"] || 12;
              greetLines.push(`Tu kit GNV (${p.folio}): mes *${mes} de ${total}*, saldo *$${saldo.toLocaleString()}*.`);
            } else if (p.producto === "Taxi Renovaci\u00f3n") {
              const mes = p.record["Mes Actual"] || 0;
              greetLines.push(`Tu cr\u00e9dito taxi (${p.folio}): mes *${mes} de 36*.`);
            }
          }
          greetLines.push(`\nPregunta lo que quieras sobre tu estado de cuenta, pagos o el programa CMU.`);
          return await respond(greetLines.join("\n"));
        }
        return await respond(`${timeGreet} ${name}. Soy el asistente de Conductores del Mundo.\n\nPuedes:\n\u2022 *mis pagos* \u2014 estado de cuenta\n\u2022 Enviar documento \u2014 para tu expediente\n\u2022 Preguntar sobre el programa CMU\n\n\u00bfEn qu\u00e9 te ayudo?`);
      }
      if (role === "prospecto") {
        return await respond(`${timeGreet}${name ? " " + name : ""}. Soy el asistente digital de *Conductores del Mundo*.\n\nTe ayudo con informaci\u00f3n sobre nuestro programa de veh\u00edculos con Gas Natural (GNV) para taxistas en Aguascalientes.\n\n\u00bfTe gustar\u00eda saber c\u00f3mo funciona? Solo dime:\n\u2022 *Cu\u00e1nto ahorro* con GNV\n\u2022 *Qu\u00e9 carros tienen* disponibles\n\u2022 *C\u00f3mo funciona* el programa\n\u2022 *Quiero registrarme*\n\nO pregunta lo que quieras.`);
      }
      // proveedor greeting already handled in its own flow
    }

    // ===== v9 FIX: DIRECTOR — ALL messages go through Canal C tone =====
    // Director can do everything (eval, docs, origination, info) but ALWAYS with Canal C tone
    if (role === "director") {
      const lower = body.toLowerCase().trim();
      
      // Detect CSV/Excel media — ALWAYS route to Canal C for recaudo processing
      const isCsvOrExcelMedia = mediaUrl && mediaType && (
        mediaType.includes("csv") || mediaType.includes("text/plain") || 
        mediaType.includes("text/tab-separated") || mediaType.includes("excel") || 
        mediaType.includes("spreadsheet") || mediaType.includes("openxmlformats") || 
        mediaType.includes("ms-excel") || mediaType.includes("octet-stream")
      );
      
      // Direct Canal C commands (eval, market, dashboard, inventory, folios, corrida)
      // Also includes client name lookups for multi-product cartera
      const clientNames = ["capetillo", "obed", "elvira", "zavala", "mauricio", "hector", "h\u00e9ctor", "manuel", "flores", "l\u00f3pez", "lopez"];
      const isClientLookup = clientNames.some(n => lower.includes(n))
        || /(?:ahorro|joylong|kit|conversi[o\u00f3]n|cu[a\u00e1]nto\s+lleva|cu[a\u00e1]nto\s+debe|estado\s+de|saldo\s+de)/.test(lower);
      const isInventoryEdit = /(?:reparaci[o\u00f3]n|cmu|precio\s*aseguradora|costo.*compra|costo.*reparaci|compra.*\d|kit.*\d|tanque.*\d)/.test(lower) && /\d+k?\s*$/.test(lower);
      const isCanalCDirect =
        isClientLookup || isInventoryEdit ||
        /^(n[u\u00fa]meros|numeros|dashboard|inventario|inv|folios|modelos|cat[a\u00e1]logo|catalogo)$/i.test(lower) ||
        /\d{2,3}\s*k\b/.test(lower) || /rep(?:araci[o\u00f3]n)?\s*\d/i.test(lower) ||
        /^\s*eval[u\u00fa]a/i.test(lower) ||
        /precio|mercado|market|cu[a\u00e1]nto\s*(cuesta|vale)/i.test(lower) ||
        /^corrida/i.test(lower) ||
        /\$?\s*\d{2,3}[,.]\d{3}/.test(lower) ||
        /\d{2,3}[.,]\d{1,2}\s*k\b/.test(lower) ||
        /\d{2,3}\s*mil\b/.test(lower) ||
        /recaudo|natgas|csv/i.test(lower) ||
        /cierre/i.test(lower) ||
        /cartera|cobranza|mora|contratos/i.test(lower) ||
        /pago\s+(?:folio|efectivo|spei|transferencia)|confirmar\s+pago/i.test(lower) ||
        /alta|iniciar proceso|registrar cliente|nuevo cliente|proceso de alta/i.test(lower);

      if (isCanalCDirect || isCsvOrExcelMedia || (!mediaUrl && !originationId)) {
        // Eval, market, dashboard, recaudo, conversational — all through Canal C
        const reply = await this.handleCanalC(phone, body, mediaUrl, mediaType);
        return await respond(reply);
      }
      
      // Director with folio+docs: falls through to A/B doc processing
      // but LLM prompt uses full knowledge base (buildKnowledgeBase, not buildClientKnowledge)
    }

    // ===== PROVEEDOR FLOW (Lilia/NATGAS) =====
    if (role === "proveedor") {
      // If media (CSV/Excel) → process as recaudo (multi-product + dedup)
      if (mediaUrl) {
        try {
          const media = await this.downloadMedia(mediaUrl, mediaType);
          
          // CSV file
          if ((media as any)._isCsv && media.pdfText) {
            if (isDuplicateFile(media.pdfText)) {
              return await respond("Este archivo ya fue procesado. No se volvio a sumar.");
            }
            const csvRows = parseNatgasCsvRows(media.pdfText);
            const summary = await processNatgasMultiProduct(csvRows);
            markFileProcessed(media.pdfText);
            return await respond(formatRecaudoSummary(summary));
          }
          
          // Excel file
          if ((media as any)._isExcel && (media as any)._excelBuffer) {
            const buf = (media as any)._excelBuffer as Buffer;
            console.log(`[Proveedor] Excel buffer: ${buf.length} bytes, magic: ${buf.slice(0, 4).toString('hex')}`);
            if (isDuplicateFile(buf)) {
              return await respond("Este archivo ya fue procesado. No se volvio a sumar.");
            }
            const rows = parseNatgasExcel(buf);
            console.log(`[Proveedor] Parsed ${rows.length} rows from Excel`);
            if (rows.length > 0) {
              const summary = await processNatgasMultiProduct(rows);
              markFileProcessed(buf);
              // Notify Josue too
              try {
                const josuePhone = "5214422022540";
                await this.sendWhatsApp(josuePhone, `(Lilia via WhatsApp) ${formatRecaudoSummary(summary)}`);
              } catch (notifyErr) { /* silent */ }
              return await respond(formatRecaudoSummary(summary));
            }
            return await respond("Recibi el Excel pero no encontre datos de CONDUCTORES DEL MUNDO. Verifica el archivo.");
          }
          
          return await respond("Recibi tu archivo. Para procesarlo, envialo como CSV o Excel (.xlsx).");
        } catch (e: any) {
          console.error(`[Proveedor] Media processing error:`, e.message, e.stack?.slice(0, 300));
          return await respond(`Error al procesar archivo: ${e.message}`);
        }
      }
      // Text message from proveedor
      const lower = body.toLowerCase().trim();
      if (lower === "hola" || lower === "buenos dias" || lower === "buenas" || lower.length < 15) {
        return await respond(`Hola ${roleName || ""}, soy el asistente digital de Conductores del Mundo.\n\nPuedes enviarme:\n- Reporte de recaudos semanal (CSV)\n- Consultas sobre recaudos procesados\n\nCuando tengas listo el reporte, mándalo aquí y lo proceso automáticamente.`);
      }
      // Any other text — fallback to LLM with limited context
      const sysProveedor = `Eres el asistente de Conductores del Mundo (CMU). Hablas con ${roleName || "un proveedor"} de NATGAS. Tu función es recibir reportes de recaudos semanales (CSV) y confirmar su procesamiento. Si pregunta algo fuera de recaudos, di que contacte a Josué Hernández. Tono: profesional, breve.`;
      const reply = await this.llm([{ role: "system", content: sysProveedor }, { role: "user", content: body }], 300);
      return await respond(reply);
    }

    // ===== PERMISSION CHECK: Prospecto cannot send docs =====
    if (role === "prospecto" && mediaUrl) {
      return await respond("Para enviar documentos necesitas un folio activo. Tu asesora Ángeles te lo puede crear. ¿Quieres saber más sobre el programa CMU primero?", null, null);
    }

    // ===== CANAL A/B SHARED LOGIC =====
    let docSaved: string | null = null;
    let visionNote: string | null = null;
    let flexSearchNote: string | null = null;
    let simulationData: string | null = null;

    // Flexible folio search (for promotora and director)
    if (!mediaUrl && body && !originationId && (role === "promotora" || role === "director")) {
      const results = await this.findFolio(body.trim());
      if (results.length === 1) {
        originationId = results[0].id;
        flexSearchNote = `[FOLIO] ${results[0].folio}${results[0].taxistaName ? ` de ${results[0].taxistaName}` : ""}`;
        // v9: Persist folio to conversation state
        await this.updateState(phone, {
          folioId: originationId,
          state: "capturing_docs",
          context: { folio: { id: originationId, folio: results[0].folio, estado: "CAPTURANDO", step: 0, docsCapturados: [], docsPendientes: [], taxistaName: results[0].taxistaName || undefined } },
        });
      }
      else if (results.length > 1) {
        return await respond(`Encontré ${results.length} folios:\n${results.map((r, i) => `${i + 1}. *${r.folio}*${r.taxistaName ? ` — ${r.taxistaName}` : ""}`).join("\n")}\n\n¿Con cuál trabajo?`, null, null);
      }
    }

    // CAMBIAR folio
    if (body && originationId) {
      const cambiarMatch = body.toLowerCase().match(/^cambiar?\s+(.+)/i);
      if (cambiarMatch && (role === "promotora" || role === "director")) {
        const results = await this.findFolio(cambiarMatch[1].trim());
        if (results.length === 1) {
          originationId = results[0].id;
          flexSearchNote = `[CAMBIO] ${results[0].folio}`;
          await this.updateState(phone, { folioId: originationId });
        }
        else if (results.length > 1) return await respond(`${results.length} folios:\n${results.map((r, i) => `${i + 1}. *${r.folio}*${r.taxistaName ? ` — ${r.taxistaName}` : ""}`).join("\n")}`, originationId, null);
        else return await respond(`No encontré "${cambiarMatch[1]}".`, originationId, null);
      }
    }

    // ===== PROMOTOR-SPECIFIC COMMANDS =====
    if (body && (role === "promotora" || role === "director")) {
      const lower = body.toLowerCase().trim();

      // Nuevo folio from promotor
      const nuevoFolioMatch = body.match(/^nuevo\s+folio\s+(.+)/i);
      if (nuevoFolioMatch) {
        const args = nuevoFolioMatch[1].trim();
        const phoneMatch = args.match(/(\d{10,13})/);
        const taxistaPhone = phoneMatch ? phoneMatch[1] : "";
        const taxistaName = args.replace(/\d{10,13}/, "").trim() || "Sin nombre";
        if (!taxistaPhone) {
          return await respond("Formato: *nuevo folio [nombre] [teléfono]*\nEjemplo: nuevo folio Juan Pérez 4491234567");
        }
        try {
          const result = await createFolioFromWhatsApp(this.storage, phone, taxistaName, taxistaPhone);
          originationId = result.originationId;
          await this.updateState(phone, {
            folioId: result.originationId,
            state: "capturing_docs",
            context: {
              folio: {
                id: result.originationId,
                folio: result.folio,
                estado: "BORRADOR",
                step: 1,
                docsCapturados: [],
                docsPendientes: DOC_ORDER.map(d => d.key),
                taxistaName,
              },
            },
          });
          return await respond(`✅ *Folio creado:* ${result.folio}\n\nTaxista: ${taxistaName}\nTel: ${taxistaPhone}\n\nYa puedes enviar documentos para este folio.\nPrimero: *INE (frente y vuelta)*`, result.originationId);
        } catch (e: any) {
          return await respond(`❌ Error al crear folio: ${e.message}`);
        }
      }

      // List active folios for promotor
      if (lower === "folios" || lower === "mis folios") {
        const origs = await this.storage.listOriginations();
        const activos = origs.filter((o: any) => !["RECHAZADO", "COMPLETADO"].includes(o.estado));
        if (!activos.length) return await respond("Sin folios activos.");
        const lines = [`📁 *Folios Activos* (${activos.length})\n`];
        for (const o of activos.slice(0, 15)) {
          const oo = o as any;
          const docs = await this.storage.getDocumentsByOrigination(oo.id);
          const cap = docs.filter((d: any) => d.imageData || d.image_data).length;
          lines.push(`• *${oo.folio}* | ${oo.estado} | Docs: ${cap}/${DOC_ORDER.length}`);
        }
        return await respond(lines.join("\n"));
      }

      // Status / pendientes / qué falta for active folio
      if (originationId && (lower === "status" || lower === "pendientes" || lower.includes("qué falta") || lower.includes("que falta"))) {
        const pInfo = await this.getPendingInfo(originationId);
        const orig = await this.storage.getOrigination(originationId);
        const folio = orig ? (orig as any).folio : "?";
        if (pInfo.count >= DOC_ORDER.length) {
          return await respond(`✅ *${folio}* — Expediente COMPLETO (${DOC_ORDER.length}/${DOC_ORDER.length} docs)\n\nListo para revisión.`);
        }
        return await respond(`📋 *${folio}* — ${pInfo.count}/${DOC_ORDER.length} documentos\n\n${pInfo.text}\n\nEnvía el siguiente documento.`);
      }
    }

    // ===== CLIENT: Payment history ("mis pagos", "historial", "saldo") =====
    if (body && role === "cliente" && isAirtableEnabled()) {
      const lower = body.toLowerCase();
      const wantsPayments = lower.includes("mis pagos") || lower.includes("historial") || lower.includes("mi saldo")
        || lower.includes("cuánto debo") || lower.includes("cuanto debo") || lower.includes("estado de cuenta")
        || lower.includes("pagos") || lower.includes("próxima cuota") || lower.includes("proxima cuota");
      if (wantsPayments) {
        try {
          const credit = await findCreditByPhone(phone);
          if (credit) {
            const payments = await getPaymentsByFolio(credit.Folio || "");
            const recaudos = await getRecaudoByFolio(credit.Folio || "", 4);
            const lines = [
              `💳 *Estado de Cuenta*`,
              `Folio: ${credit.Folio}`,
              `Mes actual: ${credit.MesActual || 0} de 36`,
              `Cuota actual: $${(credit.CuotaActual || 0).toLocaleString()}`,
              `Saldo capital: $${(credit.SaldoCapital || 0).toLocaleString()}`,
              `Fondo de Garantía: $${(credit.SaldoFG || 0).toLocaleString()}/20,000`,
            ];
            if ((credit.DiasAtraso || 0) > 0) {
              lines.push(`⚠️ Días de atraso: ${credit.DiasAtraso}`);
            }
            if (payments.length > 0) {
              lines.push(``, `Últimos pagos:`);
              for (const p of payments.slice(0, 5)) {
                lines.push(`- Mes ${(p as any).Mes || "?"}: $${((p as any).Monto || 0).toLocaleString()} (${(p as any).Concepto || (p as any).Método || "?"})`);
              }
            }
            if (recaudos.length > 0) {
              lines.push(``, `Recaudo GNV reciente:`);
              for (const r of recaudos) {
                lines.push(`- ${r.Periodo || "?"}: ${r.LEQ || 0} LEQ / $${(r.Recaudo || 0).toLocaleString()}`);
              }
            }
            lines.push(``, `CLABE para pago: 152680120000787681 (Bancrea)`);
            return await respond(lines.join("\n"));
          }
          // No credit found — fall through to normal conversation
        } catch (e: any) { console.error("[Agent] Payment history error:", e.message); }
      }
    }

    // ===== PROSPECT/CLIENT: Inventory query =====
    if (body && (role === "prospecto" || role === "cliente")) {
      const lower = body.toLowerCase();
      const wantsInventory = lower.includes("inventario") || lower.includes("qué carros") || lower.includes("que carros")
        || lower.includes("vehículos disponibles") || lower.includes("vehiculos disponibles")
        || lower.includes("qué autos") || lower.includes("que autos")
        || lower.includes("qué tienen") || lower.includes("que tienen");
      if (wantsInventory) {
        const inv = await this.getAvailableInventory();
        return await respond(inv);
      }
    }

    // ===== PROSPECT: Registration intent =====
    if (body && role === "prospecto") {
      const lower = body.toLowerCase();
      const prospectState = await this.getConvState(phone);
      
      // Step 4: OTP verification
      if (prospectState.state === "awaiting_otp") {
        const code = body.trim().replace(/\s/g, "");
        if (/^\d{4,6}$/.test(code)) {
          const { checkOTP } = await import("./twilio-verify");
          const result = await checkOTP(prospectState.context.verifyPhone || phone, code);
          if (result.valid) {
            // OTP verified — create folio
            const nombre = prospectState.context.nombre || "Prospecto";
            const tel = prospectState.context.verifyPhone || phone;
            const folioResult = await createFolioFromWhatsApp(this.storage, phone, nombre, tel);
            await this.updateState(phone, { state: "idle", context: {} });
            
            // Notify Ángeles + Josué
            const notifyMsg = `*Nuevo registro verificado*\n\nNombre: ${nombre}\nTel: ${tel}\nFolio: ${folioResult.folio || "?"}\nVerificado por OTP`;
            fetch("http://localhost:5000/api/whatsapp/send-outbound", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ to: "whatsapp:+5214493845228", body: notifyMsg }),
            }).catch(() => {});
            fetch("http://localhost:5000/api/whatsapp/send-outbound", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ to: "whatsapp:+5214422022540", body: notifyMsg }),
            }).catch(() => {});
            
            return await respond(`Numero verificado.\n\nTu folio es *${folioResult.folio}*.\nTu asesora *Angeles* te contactara para continuar con tu expediente.\n\nDocumentos que necesitaras:\n- INE (frente y reverso)\n- Tarjeta de circulacion\n- Concesion vigente\n- Comprobante de domicilio\n- Tickets de carga GNV`);
          } else {
            return await respond("Codigo incorrecto. Intenta de nuevo o escribe *reenviar* para recibir otro codigo.");
          }
        } else if (lower === "reenviar" || lower === "reenviar codigo") {
          const { sendOTP } = await import("./twilio-verify");
          await sendOTP(prospectState.context.verifyPhone || phone);
          return await respond("Reenviado. Revisa tu WhatsApp y escribeme el codigo de 6 digitos.");
        } else {
          return await respond("Escribeme el codigo de 6 digitos que recibiste por WhatsApp.");
        }
      }
      
      // Step 3: Capture phone number and send OTP
      if (prospectState.state === "awaiting_phone") {
        const phoneDigits = body.replace(/\D/g, "");
        if (phoneDigits.length >= 10) {
          const { sendOTP, isVerifyEnabled } = await import("./twilio-verify");
          if (isVerifyEnabled()) {
            const otpResult = await sendOTP(phoneDigits);
            if (otpResult.success) {
              await this.updateState(phone, {
                state: "awaiting_otp",
                context: { ...prospectState.context, verifyPhone: phoneDigits },
              });
              return await respond(`Te enviamos un codigo de verificacion por ${otpResult.channel === "whatsapp" ? "WhatsApp" : "SMS"} al ${phoneDigits}.\n\nEscribeme el codigo de 6 digitos:`);
            }
          }
          // Fallback if Verify not available: skip OTP, create folio directly
          const nombre = prospectState.context.nombre || "Prospecto";
          const folioResult = await createFolioFromWhatsApp(this.storage, phone, nombre, phoneDigits);
          await this.updateState(phone, { state: "idle", context: {} });
          return await respond(`Registrado.\n\nTu folio es *${folioResult.folio}*.\nTu asesora *Angeles* te contactara pronto.`);
        } else {
          return await respond("Necesito tu numero de celular a 10 digitos. Ejemplo: 4491234567");
        }
      }
      
      // Step 2: Capture name
      if (prospectState.state === "awaiting_name") {
        const nombre = body.trim();
        if (nombre.length >= 3 && nombre.split(/\s+/).length >= 2) {
          await this.updateState(phone, {
            state: "awaiting_phone",
            context: { nombre },
          });
          return await respond(`Gracias, ${nombre.split(" ")[0]}.\n\nAhora dame tu numero de celular (10 digitos):`);
        } else {
          return await respond("Necesito tu nombre completo (nombre y apellido). Ejemplo: Juan Perez Lopez");
        }
      }
      
      // Step 1: Detect registration intent
      const wantsToRegister = lower.includes("quiero registrarme") || lower.includes("c\u00f3mo me registro")
        || lower.includes("como me registro") || lower.includes("quiero aplicar")
        || lower.includes("me interesa registrarme") || lower.includes("quiero entrar al programa")
        || lower.includes("registrarme") || lower.includes("inscribirme");
      if (wantsToRegister) {
        await this.updateState(phone, { state: "awaiting_name", context: {} });
        return await respond("Para registrarte necesito algunos datos.\n\nPrimero, dime tu *nombre completo*:");
      }
    }

    // ===== MEDIA WITHOUT FOLIO: Intelligent association (promotor) =====
    if (mediaUrl && !originationId && (role === "promotora" || role === "director")) {
      // First check: if it's CSV/Excel, process as recaudo (no folio needed)
      const isCsvOrExcelCheck = mediaType && (
        mediaType.includes("csv") || mediaType.includes("text/plain") || 
        mediaType.includes("text/tab-separated") || mediaType.includes("excel") || 
        mediaType.includes("spreadsheet") || mediaType.includes("openxmlformats") || 
        mediaType.includes("ms-excel") || mediaType.includes("octet-stream")
      );
      if (isCsvOrExcelCheck) {
        // Route to Canal C for recaudo processing
        const reply = await this.handleCanalC(phone, body, mediaUrl, mediaType);
        return await respond(reply);
      }
      const match = await associateDocIntelligently(this.storage, phone, role, null, convState.folioId || null);
      if (match) {
        originationId = match.originationId;
        flexSearchNote = `[AUTO-ASOCIADO] ${match.folio} (${match.matchType})`;
        await this.updateState(phone, { folioId: originationId });
      } else {
        return await respond("📎 Recibí un documento pero no sé a qué folio pertenece.\n\n¿Para qué folio es? Envía el nombre del taxista o el número de folio.");
      }
    }

    // Simulation detection (for prospecto/cliente)
    if (body && (role === "prospecto" || role === "cliente")) {
      const lower = body.toLowerCase();
      const isSimQ = lower.includes("cuánto") || lower.includes("cuanto") || lower.includes("corrida") || lower.includes("pagar") || lower.includes("mensualidad");
      if (isSimQ) {
        let vQ = "march sense";
        if (lower.includes("advance")) vQ = "march advance";
        else if (lower.includes("aveo")) vQ = "aveo";
        else if (lower.includes("v-drive") || lower.includes("vdrive")) vQ = "v-drive";
        const leqMatch = lower.match(/(\d{2,4})\s*leq/);
        const leq = leqMatch ? parseInt(leqMatch[1]) : CMU.gnvLeqBase;
        simulationData = await this.simulateForTaxista(vQ, leq);
        if (simulationData) {
          await this.updateState(phone, { state: "simulation" });
        }
      }
    }

    // Build context
    let profile = originationId ? await this.buildProfile(originationId) : "Sin folio.";
    let pInfo = originationId ? await this.getPendingInfo(originationId) : { text: "Sin folio.", nextKey: null, count: 0 };
    let ctx = `Tel: ${phone} | ${roleName || profileName} | Rol: ${role}`;
    if (clientState && clientState.found) {
      ctx += ` | Folio: ${clientState.folio} | Estado: ${clientState.estado}`;
      if (clientState.taxistaName) ctx += ` | Nombre: ${clientState.taxistaName}`;
      ctx += ` | Docs: ${clientState.docsCapturados.length}/${clientState.totalDocs}`;
      if (clientState.docsPendientes.length > 0) ctx += ` | Pendientes: ${clientState.docsPendientes.join(", ")}`;
      else ctx += ` | Expediente COMPLETO`;
    } else if (originationId) {
      const orig = await this.storage.getOrigination(originationId);
      if (orig) {
        const o = orig as any;
        ctx += ` | Folio: ${o.folio} | ${o.estado}`;
        const tid = o.taxistaId || o.taxista_id;
        if (tid) { const t = await this.storage.getTaxista(tid); if (t) ctx += ` | ${(t as any).nombre}`; }
      }
    }
    const canalLabel = role === "promotora" ? "Canal B (Promotora)" : role === "director" ? "Canal B (Director — acceso completo)" : "Canal A (Taxista)";

    // Process image or PDF (Canal A/B) — v9: supports PDF via text extraction + image conversion
    if (mediaUrl && originationId && (role === "cliente" || role === "promotora" || role === "director")) {
      let media: { base64: string; wasPdf: boolean; pdfText?: string };
      try {
        media = await this.downloadMedia(mediaUrl, mediaType);
      } catch { return await respond("⚠️ No pude descargar el archivo."); }
      
      // If it's CSV/Excel (recaudo), process as recaudo even within doc capture flow
      if ((media as any)._isCsv && media.pdfText) {
        try {
          const summary = await processNatgasCsv(media.pdfText);
          return await respond(formatRecaudoSummary(summary));
        } catch (e: any) { return await respond(`Error procesando CSV: ${e.message}`); }
      }
      if ((media as any)._isExcel && (media as any)._excelBuffer) {
        try {
          const rows = parseNatgasExcel((media as any)._excelBuffer);
          if (rows.length > 0) {
            const csvLines = ["Nombre financiera,Placa,Cantidad de Recaudo,Fecha Venta,Litros de Venta,Ticket,Estacion"];
            for (const r of rows) csvLines.push(`${r.financiera},${r.placa},${r.recaudo},${r.fechaVenta},${r.litros},${r.ticket},${r.estacion}`);
            const summary = await processNatgasCsv(csvLines.join("\n"));
            return await respond(formatRecaudoSummary(summary));
          }
          return await respond("Excel recibido pero sin datos de CONDUCTORES DEL MUNDO.");
        } catch (e: any) { return await respond(`Error procesando Excel: ${e.message}`); }
      }
      
      const analysis = await this.processDocument(media, profile, pInfo.nextKey || undefined);
      const img = media.base64 || ""; // for saving to DB (empty for text-only PDFs)
      visionNote = `${DOC_LABELS[analysis.classifiedAs] || analysis.classifiedAs}. ${analysis.note}`;
      // UX: CURP validation — warn if extracted CURP has wrong length
      const extractedCurp = analysis.extractedData?.curp || analysis.extractedData?.CURP;
      if (extractedCurp && typeof extractedCurp === "string" && extractedCurp.length !== 18) {
        visionNote += ` | \u26a0\ufe0f CURP "${extractedCurp}" tiene ${extractedCurp.length} caracteres (debe ser 18). Verificar manualmente.`;
      }
      const docKey = DOC_ORDER.find(d => d.key === analysis.classifiedAs) ? analysis.classifiedAs : pInfo.nextKey;
      if (analysis.isValid && docKey) {
        const now = new Date().toISOString();
        const ocrJson = JSON.stringify(analysis.extractedData);
        const conf = Object.keys(analysis.extractedData).length > 2 ? "alta" : Object.keys(analysis.extractedData).length > 0 ? "media" : "baja";
        const existing = await this.storage.getDocumentByOriginationAndType(originationId, docKey);
        if (existing) await this.storage.updateDocument(existing.id, { imageData: img, status: "captured", ocrResult: ocrJson, ocrConfidence: conf });
        else await this.storage.createDocument({ originationId, tipo: docKey, imageData: img, ocrResult: ocrJson, ocrConfidence: conf, editedData: null, status: "captured", source: "whatsapp", createdAt: now } as any);
        docSaved = docKey;
        profile = await this.buildProfile(originationId); pInfo = await this.getPendingInfo(originationId);
        // v9: Update state with doc progress
        const allDocs2 = await this.storage.getDocumentsByOrigination(originationId);
        const capturedKeys = new Set(allDocs2.filter((d: any) => d.imageData || d.image_data).map((d: any) => d.tipo));
        const capturedList = DOC_ORDER.filter(d => capturedKeys.has(d.key)).map(d => d.key);
        const pendingList = DOC_ORDER.filter(d => !capturedKeys.has(d.key)).map(d => d.key);
        await this.updateState(phone, {
          state: "capturing_docs",
          context: {
            folio: {
              id: originationId,
              folio: convState.context.folio?.folio || "?",
              estado: "CAPTURANDO",
              step: pInfo.count,
              docsCapturados: capturedList,
              docsPendientes: pendingList,
            },
          },
        });
      }
    } else if (mediaUrl && !originationId) { visionNote = "Imagen sin folio vinculado."; }

    // Build prompt with dynamic knowledge base from business_rules
    const rulesAB = await this.getRules();
    // v9: Use buildClientKnowledge for Canal A/B (excludes motor financiero)
    const knowledgeAB = role === "director" ? buildKnowledgeBase(rulesAB) : buildClientKnowledge(rulesAB);
    const stateCtx = buildStateContext(convState);
    
    // v9: Inject Airtable cartera context for post-firma clients
    let carteraCtx = "";
    if (isAirtableEnabled() && (role === "cliente" || role === "prospecto" || role === "promotora" || role === "director")) {
      try {
        const cartera = await buildClientCarteraContext(phone);
        if (cartera) carteraCtx = "\n" + cartera;
      } catch (e: any) {
        console.error("[Agent] Airtable cartera error:", e.message);
      }
    }
    
    const sys = SYSTEM_PROMPT_AB
      .replace("{knowledgeBase}", knowledgeAB)
      .replace("{fuelContext}", fuel.text)
      .replace("{canal}", canalLabel).replace("{context}", ctx).replace("{profile}", profile).replace("{pending}", pInfo.text)
      .replace("{simulation}", simulationData ? `\n=== SIMULACION ===\n${simulationData}` : "")
      .replace("{stateContext}", stateCtx + carteraCtx);
    let userMsg = body || "(imagen)";
    if (flexSearchNote) userMsg += `\n${flexSearchNote}`;
    if (visionNote) userMsg += `\n[VISION: ${visionNote}]`;
    if (docSaved) userMsg += `\n[GUARDADO: ${DOC_LABELS[docSaved]} — ${pInfo.count}/${DOC_ORDER.length}]`;
    if (simulationData) userMsg += `\n[SIMULACIÓN LISTA — incluir en respuesta]`;

    // Include conversation history for context
    const history = this.getHistoryForLLM(phone, 10);
    const llmMessages: any[] = [{ role: "system", content: sys }, ...history, { role: "user", content: userMsg }];
    const reply = await this.llm(llmMessages, simulationData ? 1000 : 600);
    return await respond(reply, originationId, docSaved);
  }
}
