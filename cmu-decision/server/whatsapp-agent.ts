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
import { detectCanal, upsertProspect, updateProspectStatus } from "./pipeline-ventas";
import { generarCorridaEstimada, getModelosDisponiblesText, MODELOS_PROSPECTO, generarResumen5Modelos, matchModelFromText, getPvForModel } from "./corrida-estimada";
import { getPromotor, DIRECTOR, PROMOTOR_LABEL, JOSUE_PHONE, ANGELES_PHONE, LILIA_PHONE } from "./team-config";
import { DOC_ORDER as AGENT_DOC_ORDER, DOC_KEYS, DOC_LABELS as VISION_DOC_LABELS } from "./agent/vision";
import { buildSystemPrompt } from "./prompts";
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
    gnvPrice: gnvPrecio,
    gasolinaPrice: magnaPrecio,
    ahorroPerLeq: magnaPrecio - gnvPrecio,
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
  { key: "carta_membresia", label: "Carta Gremial o de Ingreso", visualId: "papel membretado organización taxistas, sello, firma líder", extract: "tipo_carta, agrupacion, nombre_concesionario, concesion, placa, ingreso_mensual, fecha, tiene_sello, tiene_membrete", crossCheck: "Nombre=INE. Sello+membrete+firma obligatorios." },
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
Filosofía: TU GUÍAS LA CONVERSACIÓN. No esperes a que el usuario adivine qué decir. Haz UNA pregunta a la vez y avanza.
NUNCA pidas datos largos (CURP, RFC, CLABE). Extráelos de fotos. Acepta nombre/parcial/"el último" para folios.
Español mexicano coloquial. Respuestas cortas (3-4 líneas max en WhatsApp). Maximo 1 emoji por mensaje. Tono profesional y cálido.

IMPORTANTE: SÍ puedes recibir fotos, imágenes Y PDFs por WhatsApp. NUNCA digas que no puedes recibir PDFs.
Cuando el usuario pregunte por datos que ya extrajiste de un documento (nombre, CURP, número INE, CLABE), respóndelos directamente de los datos que tienes.

Eres EXPERTO en el programa CMU. Usa la siguiente base de conocimiento:

{knowledgeBase}

{simulation}

Documentos para cross-check: ${DOC_ORDER.map((d, i) => `${i + 1}. ${d.label}`).join(" | ")}
INE = FUENTE DE VERDAD.

{fuelContext}

=== COMPORTAMIENTO POR ROL (TÚ GUÍAS, ELLOS RESPONDEN) ===

PROSPECTO (sin registro):
Eres un vendedor consultivo honesto. Tu trabajo es llevar al taxista de "¿qué es esto?" a "¿cuánto pagaría?" en 3-4 mensajes.
- SIEMPRE pregunta primero: "¿Tu taxi ya usa gas natural o gasolina?"
- Si GNV: pregunta cuántos litros carga al mes y calcula su diferencial real
- Si gasolina: pregunta cuánto gasta de gasolina al mes, calcula cuánto ahorraría con GNV
- Después de calcular: dile cuánto pagaría de más al mes por un taxi seminuevo (rango $2,000-$4,000 según consumo)
- NUNCA digas "no lo va a sentir" ni "se paga solo". Sé honesto: "Tu ahorro cubre parte de la cuota. El resto, unos $X/mes, sale de tu bolsilla."
- Si muestra interés ("va", "sí", "me interesa", "le entro", "dime más", "cómo le hago", "qué necesito"): ofrécele apuntarse en la lista. NO pidas "escribe quiero registrarme" — detecta la intención.
- Manejamos March, Aveo, i10 seminuevos. NO muestres inventario real ni unidades específicas.
- NUNCA des cuotas mensuales específicas. Solo el rango de diferencial: "entre $2,000 y $4,000/mes de pago extra, dependiendo del vehículo y tu consumo."
- NUNCA muestres menús de opciones ("escribe 1 para..."). Solo conversa natural.

CLIENTE (con folio):
Eres su guía de trámite. Tu trabajo es que complete su expediente lo más rápido posible.
- Al saludar: dile su status PRIMERO. "Hola [nombre], tu folio va en paso X. Te falta: [documento]. ¿Me lo mandas?"
- Cuando mande un documento: confirma y pide el siguiente. "Listo, ya tengo tu INE. Ahora necesito tu comprobante de domicilio."
- Si pregunta "qué me falta": lista exacta de documentos pendientes, no un menú genérico.
- Si pregunta sobre pagos/cuotas: da su estado de cuenta y explica el diferencial.
- NUNCA respondas con menú de opciones. Lee su contexto y responde directo.

PROMOTORA:
Eres su copiloto rápido. La promotora maneja múltiples folios y necesita respuestas inmediatas.
- Si dice un nombre/apellido: busca el folio y da status completo (paso, docs pendientes, último movimiento).
- Si manda foto: procésala y dile qué sigue ("Procesé la INE de Pérez. Ahora falta el reverso.").
- Si pregunta "pendientes" o "cuántos tengo": lista de folios activos con status cada uno.
- Si pregunta sobre el programa: responde como experta que es, sin explicar lo básico.
- Eficiente, directa, sin rodeos. La promotora no tiene tiempo para menús.
- SIGUIENTE ACCIÓN: siempre dile qué sigue en el flujo:
  - Docs incompletos → "Le falta [doc]. ¿Quieres que le mande un recordatorio?"
  - Docs completos, paso 2 → "Docs completos. Falta la entrevista. ¿Le mando mensaje para agendar o quieres iniciar entrevista por WhatsApp?"
  - Para iniciar entrevista por WhatsApp escribe "iniciar entrevista" cuando estés en el folio del taxista.
  - Entrevista hecha, paso 3+ → "Pendiente verificación OTP / asignación de vehículo."
- Si la promotora dice "sí" o "mándale" después de que sugieras enviar mensaje al taxista, envía el mensaje al taxista vía el folio vinculado.

=== REGLAS CRÍTICAS ===
1. DIFERENCIAL: cuota - recaudo GNV + $334 FG = lo que paga de su bolsillo. Siempre explícalo.
2. Obligaciones legales: concesión vigente 36 meses, seguro, licencia, alta SAT transporte.
3. NUNCA muestres menús tipo "escribe 1, 2, 3" ni listas de opciones. Conversa natural.
4. Si no entiendes algo, pregunta. No asumas.

=== PRODUCTOS CMU (3 tipos) ===
1. JOYLONG AHORRO: Ahorro para autobús $799k. Sin cuota, sin mora. Pregunta típica: "cuánto llevo?"
2. KIT CONVERSION: Kit GNV $55,500 a 12 meses. Paga vía sobreprecio GNV ($10/LEQ). Pregunta: "cuánto debo?"
3. TAXI RENOVACION: Taxi seminuevo a 36 meses, amortización alemana. Pregunta: "cuánto es mi cuota?"
Identifica el producto por el contexto de cartera inyectado.

=== ESTADO DE LA CONVERSACIÓN ===
{stateContext}

Canal actual: {canal} | {context}
Perfil: {profile} | Pendientes: {pending}

INSTRUCCIONES DE CONTINUIDAD:
- Si el estado dice VEHÍCULO EN DISCUSIÓN, asume ese vehículo si el usuario no menciona otro.
- Si el estado dice FOLIO ACTIVO, responde en contexto de ese folio sin preguntar.
- Si el estado dice EVALUACIÓN EN CURSO, continúa con esos datos.
- Si no hay estado previo, guía desde el inicio según el rol.

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

10. carta_membresia: Carta gremial o de ingreso (papel membretado, sello, firma del líder).

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
  async getConvState(phone: string): Promise<ConvSession> {
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

  // ===== LLM (Claude Haiku with OpenAI fallback) =====
  private async llm(messages: any[], maxTok = 600): Promise<string> {
    try {
      const { claudeCompletion } = await import("./agent/claude-helper");
      return await claudeCompletion(messages, { max_tokens: maxTok, module: "conversational" });
    } catch (e: any) {
      console.error("[Agent] Claude failed, trying OpenAI:", e.message);
      try {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST", headers: { "Authorization": `Bearer ${this.key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens: maxTok, temperature: 0.5 }),
        });
        const d = await r.json();
        if (d.error) { console.error("[Agent]", d.error.message); return "Tuve un problema, intenta de nuevo."; }
        return d.choices?.[0]?.message?.content || "Sin respuesta.";
      } catch (e2: any) { console.error("[Agent]", e2.message); return "Error de conexión."; }
    }
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

    // Regular image or PDF-converted-to-image: use full Vision pipeline (same as Canal A)
    // This ensures cross-check rules, existingData comparison, and full field extraction run
    if (media.base64) {
      try {
        const { classifyAndValidateDoc, DOC_ORDER: docOrder } = await import("./agent/vision");
        // Build existingData from already-extracted OCR data passed in profile context
        // Parse structured data from the profile string for cross-check
        const existingData: Record<string, any> = {};
        // Also try to parse from originationExistingData if available (set by caller)
        if ((media as any)._existingData) {
          Object.assign(existingData, (media as any)._existingData);
        }
        const result = await classifyAndValidateDoc(
          media.base64,
          expectedKey || "otro",
          docOrder,
          existingData,
        );
        const flags = result.cross_check_flags || [];
        const flagStr = flags.length > 0 ? ` | \u26a0\ufe0f ${flags.join(", ")}` : "";
        return {
          classifiedAs: result.detected_type || expectedKey || "otro",
          isValid: result.is_legible !== false && result.detected_type !== "otro",
          extractedData: result.extracted_data || {},
          note: `${result.detected_type || "otro"}${flagStr}`,
        };
      } catch (e: any) {
        console.error("[processDocument] classifyAndValidateDoc error:", e.message);
        // Fallback to old vision
        return await this.vision(media.base64, profile, expectedKey);
      }
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
    p25: number | null; p70: number | null; p75: number | null; avg_band: number | null; sourceCount: number; warnings: string[];
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
        p25: data.p25 || null, p70: data.p70 || null, p75: data.p75 || null,
        avg_band: data.avg_band || null, sourceCount: data.sourceCount || 0,
        warnings: data.warnings || [],
      };
    } catch (e: any) {
      console.error("[Agent] Market prices error:", e.message);
      return { avg: null, min: null, max: null, median: null, count: 0, sources: "error", fallback: true,
        p25: null, p70: null, p75: null, avg_band: null, sourceCount: 0, warnings: [] };
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
    const yearMatch = lower.match(/20(1[5-9]|2[0-9]|3[0-9])/);
    if (yearMatch) year = parseInt(yearMatch[0]);

    // Extract repair FIRST (before cost, so we don't confuse "rep 25k" with cost)
    // Pattern 0: "0 reparación" / "0 rep" / "0 de reparación" (explicit zero)
    const zeroRepMatch = lower.match(/\b0\s*(?:k\s*)?(?:de\s+)?rep(?:araci[oó]n)?\b/i)
      || lower.match(/rep(?:araci[oó]n)?\s*(?:de\s+)?(?:\$\s*)?0\b/i)
      || lower.match(/\b0\s+reparaci[oó]n\b/i);
    if (zeroRepMatch) {
      repair = 0;
    }
    const repMatch = !zeroRepMatch ? (
      lower.match(/(\d{1,3}(?:\.\d+)?)\s*k[,\s]+(?:de\s+)?rep(?:araci[oó]n)?\b/i)
      || lower.match(/(\d{1,3}(?:\.\d+)?)\s*k\s*,?\s*(?:de\s+)?rep(?:araci[oó]n)?\b/i)
      || lower.match(/rep(?:araci[oó]n)?(?:\s+(?:es\s+)?(?:de\s+)?)?\$?\s*(\d{1,3}(?:\.\d+)?)\s*(?:mil|k)/i)
      || lower.match(/rep(?:araci[oó]n)?(?:\s+(?:es\s+)?(?:de\s+)?)?\$?\s*(\d{1,3}),(\d{3})/i)
      || lower.match(/rep(?:araci[oó]n)?(?:\s+(?:es\s+)?(?:de\s+)?)?\$?\s*(\d{4,6})/i)
      || lower.match(/rep\s+(\d{1,3})\s*k?\b/i)
    ) : null;
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
      .replace(/\d{1,3}(?:\.\d+)?\s*k[,\s]+rep(?:araci[oó]n)?\b/gi, "")  // "10k reparación"
      .replace(/rep(?:araci[oó]n)?(?:\s+(?:es\s+)?(?:de\s+)?)?\$?\s*\d+\s*k?/gi, "")
      .replace(/\brep(?:araci[oó]n)?\b/gi, "")  // leftover
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
      
      // Any year mismatch → go to market, fetch real 2024 data, auto-insert into catalog
      console.log(`[ResolveModel] ${q} ${year} not in catalog (closest=${closest}, diff=${diff}) — triggering market flow`);
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

  private formatEvalResult(r: EvaluationResult, marketData?: { avg: number | null; min: number | null; max: number | null; median: number | null; count: number; sources: string; fallback: boolean; p25?: number | null; p70?: number | null; p75?: number | null; avg_band?: number | null; sourceCount?: number; warnings?: string[] }, gnvRevenue?: number, thresholds?: ReturnType<typeof getThresholds>): string {
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
      r.precioCapped ? `⚠️ Precio tope: ajustado a PM CMU (P70) $${r.precioMaxCMU.toLocaleString()}` : 
      (r as any).precioAjustado ? `🟢 PV ajustado: catálogo $${((r as any).precioOriginal || r.cmu).toLocaleString()} → mercado×0.95 = $${r.precioContado.toLocaleString()}` : "",
    ];

    if (marketData && marketData.count > 0) {
      const mktLines = [
        ``,
        `*MERCADO* (${marketData.count} listings, ${marketData.sourceCount || "?"} fuentes)`,
      ];
      if (marketData.p25 && marketData.p75) {
        mktLines.push(`Rango P25-P75: $${marketData.p25.toLocaleString()} – $${marketData.p75.toLocaleString()}`);
      }
      if (marketData.avg_band) {
        mktLines.push(`Promedio banda: $${marketData.avg_band.toLocaleString()}`);
      }
      if (marketData.p70) {
        mktLines.push(`PM CMU (P70): $${marketData.p70.toLocaleString()}`);
      }
      mktLines.push(`Fuentes: ${marketData.sources}${marketData.fallback ? " (catálogo)" : ""}`);
      // Warnings
      if (marketData.warnings && marketData.warnings.length > 0) {
        for (const w of marketData.warnings) {
          mktLines.push(`⚠️ ${w}`);
        }
      }
      lines.push(...mktLines);
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
    const yearMatch = lower.match(/20(1[5-9]|2[0-9]|3[0-9])/);
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
    // GUARD: skip edit flow ONLY if message has BOTH a main price AND a repair cost
    // (i.e. two distinct numbers). Single-number messages like "reparacion aveo 30k" still
    // go through the edit flow normally.
    const looksLikeEval = (() => {
      const p = this.parseEvalLine(lower);
      return p.cost !== null && p.repair !== null && p.modelQuery !== null && p.modelQuery.length >= 2;
    })();
    // Flexible: "reparacion aveo 30k" OR "cambiar reparacion del aveo a 30k" OR "costo reparacion march sense 15000"
    const editFieldMatch = looksLikeEval ? null : lower.match(/(?:reparaci[o\u00f3]n|rep(?:aracion)?|cmu|precio\s*(?:de\s*)?(?:venta|cmu)|precio\s*aseguradora|costo\s*(?:de\s*)?(?:compra|adquisicion|reparaci[o\u00f3]n)|compra|kit|tanque|gnv)/i);
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

    // ===== FIRMA DIGITAL — MIFIEL (firmar folio X) =====
    const firmaMatch = lower.match(/^firmar\s+(?:folio\s+)?(.+)/i);
    if (firmaMatch) {
      const folioHint = firmaMatch[1].trim();
      // Find origination
      const origs = await this.storage.listOriginations();
      const orig = origs.find((o: any) => {
        const folio = (o.folio || "").toLowerCase();
        const nombre = (o.taxistaNombre || o.taxista_nombre || "").toLowerCase();
        return folio.includes(folioHint.toLowerCase()) || nombre.includes(folioHint.toLowerCase());
      });
      if (!orig) return `No encontre folio "${folioHint}". Usa: firmar folio [numero o nombre]`;
      
      const o = orig as any;
      const nombre = o.taxistaNombre || o.taxista_nombre || "Cliente";
      const tel = o.taxistaTelefono || o.taxista_telefono || "";
      const folio = o.folio || "";
      
      // Call mifiel/send endpoint
      try {
        const res = await fetch("http://localhost:5000/api/mifiel/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            originationId: o.id,
            signerName: nombre,
            signerEmail: "firma@conductores.lat",
            signerPhone: tel,
          }),
        });
        const data = await res.json();
        if (data.success) {
          const linkInfo = data.signingUrl ? `\nLink: ${data.signingUrl}` : "";
          return `Contrato enviado para firma.\n${folio} — ${nombre}${linkInfo}\n${data.simulated ? "(Simulado — Mifiel sandbox)" : "Link enviado por WhatsApp al taxista."}`;
        }
        return `Error al enviar firma: ${data.message}`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
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
      const liliaPhone = `whatsapp:+${LILIA_PHONE}`;
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
    if (false as boolean) { // DISABLED — this runs in handleMessage now
      const pe = (null as any).context.pendingEval as any;
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
          const result = evaluateOpportunity(input, mData, { gnvRevenue: fuel.gnvRevenueMes, marketAvgPrice: mkt.avg, marketP70: mkt.p70 });
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
            const result = evaluateOpportunity(input, mData, { gnvRevenue: fuel.gnvRevenueMes, marketAvgPrice: mkt.avg, marketP70: mkt.p70 });
            await this.autoInsertCatalogModel(brandFromMap, pe.modelName, matchedVariant, pe.year, marketCmu);
            return `\u26a0\ufe0f *No est\u00e1 en cat\u00e1logo CMU* \u2014 usando precio de mercado\nPV = mercado $${mkt.avg.toLocaleString()} \u00d7 0.95 = *$${marketCmu.toLocaleString()}*\n\n` + this.formatEvalResult(result, mkt, fuel.gnvRevenueMes, getThresholds(rules));
          }
        }
        return `No encontr\u00e9 ${pe.modelName} ${matchedVariant} ${pe.year} en mercado. Intenta con el nombre completo.`;
      }
      // Didn't match a variant — clear state and continue normal flow
      await this.updateState(phone, { state: "idle", context: {} });
    }

    // ===== CLIENT MENU HANDLERS =====
    const convStateCheck = await this.getConvState(phone);
    const isClientMenu = (convStateCheck as any).state === "client_menu";
    if (isClientMenu) {
      const clientCredit = (convStateCheck as any).context?.clientCredit;
      if (clientCredit) {
        const { clientEstadoCuenta, clientHacerPago, clientRecaudoGNV, clientGreeting } = await import("./client-menu");
        
        // Option 1: Estado de cuenta
        if (lower === "1" || /estado.*cuenta|cu[aá]nto\s+debo|saldo|deuda/i.test(lower)) {
          return await respond(await clientEstadoCuenta(clientCredit));
        }
        // Option 2: Hacer pago
        if (lower === "2" || /pag(?:o|ar)|liga.*pago|c[oó]mo\s+pago|clabe/i.test(lower)) {
          return await respond(clientHacerPago(clientCredit));
        }
        // Option 3: Recaudo GNV
        if (lower === "3" || /recaudo|gnv|gas.*carg|mi\s+gas|litros/i.test(lower)) {
          return await respond(await clientRecaudoGNV(clientCredit));
        }
        // Option 4: Promotor
        if (lower === "4" || /promotor|asesor|persona|ayuda/i.test(lower)) {
          try {
            const { notifyTeam } = await import("./agent/notifications");
            await notifyTeam(`📲 *Cliente solicita atención*\n\nNombre: ${clientCredit.nombre}\nTel: ${phone}\nFolio: ${clientCredit.folio}\nProducto: ${clientCredit.type}`);
          } catch {}
          return await respond(`Tu promotor te contactará en breve. Tu folio es *${clientCredit.folio}*.\n\n_Si es urgente, puedes llamar directamente._`);
        }
        
        // RAG for FAQ questions
        try {
          const { answerQuestion } = await import("./agent/rag");
          const ragAnswer = await answerQuestion(body);
          if (ragAnswer) return await respond(ragAnswer);
        } catch {}
        
        // Re-show menu for unrecognized input
        const hour = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" })).getHours();
        const tg = hour >= 5 && hour < 12 ? "Buenos días" : hour >= 12 && hour < 18 ? "Buenas tardes" : "Buenas noches";
        return await respond(clientGreeting(clientCredit, tg));
      }
    }

    // ===== EVALUATION always runs first if there are eval signals, even in conversational text =====
    const earlyParsed = this.parseEvalLine(cmd);
    const earlyEvalSignals = earlyParsed.cost || earlyParsed.repair || lower.startsWith("evalua") || lower.startsWith("eval\u00faa");
    
    // GUARD: If the message is a conversational question referencing previous evals
    // (e.g. "me conviene ofertar por los dos 300k", "tomando en cuenta...", "crees que vale la pena..."),
    // skip the eval parser and let the LLM handle it with conversation context.
    const isConversationalQuestion = /(?:conviene|vale la pena|crees|opinas|recomiendas|tomando en cuenta|considerando|los (?:dos|tres|ultimos)|ambos|comparando|que piensas|deber[ií]a|me sale|es buena|buena opci[oó]n|qu[eé] tal si)/i.test(lower);
    
    if (earlyEvalSignals && !isConversationalQuestion) {
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
                    repair: earlyParsed.repair !== null ? earlyParsed.repair : 10000,
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
            eval: { cost: earlyParsed.cost, repair: earlyParsed.repair !== null ? earlyParsed.repair : 10000, conTanque: earlyParsed.conTanque },
          },
        });
        const fuel = await this.getFuel();
        // Use user's specified year for market fetch + title (not catalog year)
        const displayYear = earlyParsed.year || model.year;
        const mkt = await this.fetchMarketPrices(model.brand, model.model, displayYear, model.variant);
        // Validate market data: PM CMU = P70 (preferred), fallback to avg
        // If <5 samples or >40% deviation from catalog, don't use for PV rule
        const rawPM = mkt.p70 || mkt.avg; // P70 takes priority
        let validMarketAvg: number | null = mkt.avg;
        let validMarketP70: number | null = mkt.p70 || null;
        if (rawPM && model.cmu > 0) {
          const ratio = rawPM / model.cmu;
          const isVerified = mkt.sources && mkt.sources.toLowerCase().includes('verificad');
          const enoughSamples = isVerified ? mkt.count >= 2 : mkt.count >= 5;
          if (!enoughSamples && !isVerified) {
            // Scraped prices with insufficient samples — skip cap
            console.log(`[Eval] Market scraped data insufficient: ${mkt.count} samples — skipping cap`);
            validMarketAvg = null;
            validMarketP70 = null;
          } else if (ratio > 1.40) {
            // Market suspiciously HIGH vs CMU — likely bad data
            console.log(`[Eval] Market data suspiciously high: ratio=${ratio.toFixed(2)} — skipping cap`);
            validMarketAvg = null;
            validMarketP70 = null;
          } else if (ratio < 1.0) {
            // Market LOWER than CMU — MUST apply cap (core PV rule)
            console.log(`[Eval] PM CMU $${rawPM.toLocaleString()} < CMU $${model.cmu.toLocaleString()} (ratio=${ratio.toFixed(2)}) — applying PV cap`);
            // validMarketP70/validMarketAvg stays set
          }
        }
        const m = model as any;
        const mData = { brand: m.brand, model: m.model, variant: m.variant, slug: m.slug, purchaseBenchmarkPct: m.purchaseBenchmarkPct || m.purchase_benchmark_pct || 0.60 };
        const input: EvaluationInput = { modelId: m.id, modelSlug: m.slug, year: displayYear, cmu: m.cmu, insurerPrice: earlyParsed.cost, repairEstimate: earlyParsed.repair !== null ? earlyParsed.repair : 10000, conTanque: earlyParsed.conTanque };
        const rules = await this.getRules();
        // Load per-model Dif m3 thresholds from business_rules (rules is a Map)
        const umbralGlobalRule = rules.get ? rules.get('umbral_dif_m3_global') : (rules as any)['umbral_dif_m3_global'];
        const umbralGlobal = parseInt((umbralGlobalRule as any)?.value || umbralGlobalRule || '7000') || 7000;
        const umbralByModel: Record<string, number> = {};
        const rulesEntries = rules.entries ? Array.from(rules.entries()) : Object.entries(rules);
        for (const [k, v] of rulesEntries) {
          const match = k.match(/^umbral_dif_m3_(.+)$/);
          if (match && match[1] !== 'global') {
            const val = (v as any)?.value || v;
            umbralByModel[match[1]] = parseInt(val as string) || 7000;
          }
        }
        const result = evaluateOpportunity(input, mData, { gnvRevenue: fuel.gnvRevenueMes, marketAvgPrice: validMarketAvg, marketP70: validMarketP70, umbralDifM3Global: umbralGlobal, umbralDifM3ByModel: umbralByModel });
        const formatted = this.formatEvalResult(result, mkt, fuel.gnvRevenueMes, getThresholds(rules));
        // Store full corrida so "Sí" returns it directly (no LLM hallucination)
        if (result.decision !== "NO COMPRAR") {
          const corridaLines: string[] = [
            `*CORRIDA COMPLETA — ${m.brand} ${m.model}${m.variant ? " " + m.variant : ""} ${displayYear}*`,
            ``,
            `*COSTOS*`,
            `  Aseguradora: $${(earlyParsed.cost || 0).toLocaleString()}`,
            `  Reparación: $${(input.repairEstimate || 0).toLocaleString()}`,
            `  Kit GNV: $${result.kitGnv.toLocaleString()} (${earlyParsed.conTanque ? "con tanque" : "sin tanque"})`,
            `  *Total: $${result.totalCost.toLocaleString()}*`,
            ``,
            `*PRECIO CMU*`,
            `  Contado: $${result.precioContado.toLocaleString()}`,
            `  A plazos (36m): $${result.ventaPlazos.toLocaleString()}`,
            `  Margen: $${result.margin.toLocaleString()}`,
            ``,
            `*RENTABILIDAD*`,
            `  TIR Base: ${(result.tirBase * 100).toFixed(1)}% | Operativa: ${(result.tirOperativa * 100).toFixed(1)}% | Completa: ${(result.tirCompleta * 100).toFixed(1)}%`,
            `  MOIC: ${result.moic.toFixed(2)}x | Payback: mes ${result.paybackMonth ?? "N/A"}`,
            ``,
            `*RIESGO CLIENTE ${result.riesgoCliente.nivel === "BAJO" ? "🟢" : result.riesgoCliente.nivel === "MEDIO" ? "🟡" : "🔴"} ${result.riesgoCliente.nivel}*`,
            `  Diferencial m1: $${result.riesgoCliente.diferencialM1.toLocaleString()} | m3: $${result.riesgoCliente.diferencialM3.toLocaleString()}`,
            `  Pago extra m1: $${(result.riesgoCliente.diferencialM1 + 334).toLocaleString()}/mes`,
            `  Pago extra m3+: $${(result.riesgoCliente.diferencialM3 + 334).toLocaleString()}/mes`,
            ``,
            `*VEREDICTO: ${result.decision === "COMPRAR" ? "✅" : "⚠️"} ${result.decision}*`,
          ];
          await this.updateState(phone, {
            state: "evaluating",
            context: {
              vehicle: { brand: m.brand, model: m.model, variant: m.variant, year: displayYear, cmu: m.cmu, inCatalog: true },
              eval: { cost: earlyParsed.cost, repair: input.repairEstimate, conTanque: earlyParsed.conTanque },
              pendingCorrida: corridaLines.join("\n"),
            },
          });
        }
        return formatted;
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
            const input: EvaluationInput = { modelId: 0, modelSlug: slug, year: searchYear, cmu: marketCmu, insurerPrice: earlyParsed.cost, repairEstimate: earlyParsed.repair !== null ? earlyParsed.repair : 10000, conTanque: earlyParsed.conTanque };
            const fuel = await this.getFuel();
            const rules = await this.getRules();
            const result = evaluateOpportunity(input, mData, { gnvRevenue: fuel.gnvRevenueMes, marketAvgPrice: mkt.avg, marketP70: mkt.p70 });
            
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
        const input: EvaluationInput = { modelId: model.id, modelSlug: model.slug, year: model.year, cmu: model.cmu, insurerPrice: p.cost, repairEstimate: p.repair !== null ? p.repair : 10000, conTanque: p.conTanque };
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
      const input: EvaluationInput = { modelId: model.id, modelSlug: model.slug, year: model.year, cmu: model.cmu, insurerPrice: parsed.cost, repairEstimate: parsed.repair !== null ? parsed.repair : 10000, conTanque: parsed.conTanque };
      const rules2 = await this.getRules();
      const result = evaluateOpportunity(input, { brand: model.brand, model: model.model, variant: model.variant, slug: model.slug, purchaseBenchmarkPct: model.purchaseBenchmarkPct }, { gnvRevenue: fuel2.gnvRevenueMes, marketAvgPrice: mkt2.avg, marketP70: mkt2.p70 });
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
    // Phase 2: Use modular prompt for director
    const sys = buildSystemPrompt("director", {
      knowledgeBase: knowledgeC,
      stateContext: stateCtx + "\n" + lastModelCtx + "\n" + rulesCtx + "\nMODELOS EN CATÁLOGO:\n" + modelList,
      profile: ctx + carteraDirector
    });
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
      // For prospectos: only load originationId if they have a folio in conversation state
      // (don't let stale folios from previous tests hijack the flow)
      if (role === "prospecto") {
        const pConvState = await this.getConvState(phone);
        if (pConvState.folioId) {
          originationId = pConvState.folioId;
          console.log(`[Agent] Prospect ${phone} has folio from conv state: ${originationId}`);
        }
      } else {
        originationId = clientState.originationId;
        console.log(`[Agent] Client state loaded for ${phone}: folio=${clientState.folio}, docs=${clientState.docsCapturados?.length || 0}/${clientState.totalDocs}`);
      }
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
          const mkt = await this.fetchMarketPrices(model.brand, model.model, model.year, model.variant).catch(() => ({ count: 0, avg: null as number | null, min: null, max: null, median: null, p70: null as number | null, p25: null, p75: null, avg_band: null, sourceCount: 0, warnings: [] as string[], sources: "error", fallback: true }));
          const m = model as any;
          const mData = { brand: m.brand, model: m.model, variant: m.variant, slug: m.slug, purchaseBenchmarkPct: m.purchaseBenchmarkPct || m.purchase_benchmark_pct || 0.60 };
          const input: EvaluationInput = { modelId: m.id, modelSlug: m.slug, year: m.year, cmu: m.cmu, insurerPrice: pe.cost, repairEstimate: pe.repair, conTanque: pe.conTanque ?? true };
          const rules = await this.getRules();
          const result = evaluateOpportunity(input, mData, { gnvRevenue: fuel.gnvRevenueMes, marketAvgPrice: mkt.avg, marketP70: mkt.p70 });
          return await respond(this.formatEvalResult(result, mkt, fuel.gnvRevenueMes, getThresholds(rules)));
        }
        // Not in catalog for that year → try market-based
        const brandFromMap = WhatsAppAgent.BRAND_MAP[(pe.modelName || "").toLowerCase()] || null;
        if (brandFromMap) {
          const searchName = `${pe.modelName} ${matchedVariant}`;
          const mkt = await this.fetchMarketPrices(brandFromMap, searchName, pe.year).catch(() => ({ count: 0, avg: null as number | null, min: null, max: null, median: null, p70: null as number | null, p25: null, p75: null, avg_band: null, sourceCount: 0, warnings: [] as string[], sources: "error", fallback: true }));
          if (mkt.count > 0 && mkt.avg) {
            const marketCmu = Math.round(mkt.avg * 0.95 / 1000) * 1000;
            const slug = `${brandFromMap}-${pe.modelName}-${matchedVariant}`.toLowerCase().replace(/\s+/g, "-");
            const mData = { brand: brandFromMap, model: searchName, variant: null as string | null, slug, purchaseBenchmarkPct: 0.65 };
            const input: EvaluationInput = { modelId: 0, modelSlug: slug, year: pe.year, cmu: marketCmu, insurerPrice: pe.cost, repairEstimate: pe.repair, conTanque: pe.conTanque ?? true };
            const fuel = await this.getFuel();
            const rules = await this.getRules();
            const result = evaluateOpportunity(input, mData, { gnvRevenue: fuel.gnvRevenueMes, marketAvgPrice: mkt.avg, marketP70: mkt.p70 });
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

    // ===== PROMOTORA SESSION EXPIRY — re-auth after 15 min inactivity =====
    // The origination (folio BORRADOR) lives in DB → never lost during re-auth.
    // Only the conversational context (selected folio, state) needs to be confirmed.
    if (role === "promotora") {
      const PIN_SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
      const lastActivity = convState?.lastActivity || 0;
      const elapsed = Date.now() - lastActivity;
      const isExpired = lastActivity > 0 && elapsed > PIN_SESSION_TTL_MS;
      const isPinAttempt = /^\d{6}$/.test(body.trim());
      const isReauthPending = (convState?.context as any)?.awaiting_reauth === true;

      if (isExpired && !isPinAttempt && !isReauthPending) {
        // Mark that we're awaiting re-auth (to avoid looping)
        await this.updateState(phone, {
          state: convState.state,
          context: { ...convState.context, awaiting_reauth: true, reauth_folio_id: originationId },
        });
        const folioHint = originationId
          ? `\n\nNo te preocupes — tu folio sigue guardado.`
          : "";
        return await respond(`🔒 Tu sesión expiró por inactividad. Escribe tu *PIN* para continuar.${folioHint}`);
      }

      if (isReauthPending && isPinAttempt) {
        const { PROMOTORES, DIRECTOR } = await import("./team-config");
        // Accept any valid team PIN — no phone match required (supports test phones)
        const promotor = PROMOTORES.find(p => p.pin === body.trim());
        const isDirector = body.trim() === DIRECTOR.pin;
        if (promotor || isDirector) {
          const savedFolioId = (convState?.context as any)?.reauth_folio_id || originationId;
          if (savedFolioId) originationId = savedFolioId;
          await this.updateState(phone, {
            state: convState.state,
            context: { ...convState.context, awaiting_reauth: false, reauth_folio_id: undefined },
          });
          const name2 = promotor?.nombre || DIRECTOR.nombre;
          return await respond(`✅ Sesión restaurada, ${name2.split(" ")[0]}. ¿Continuamos?${savedFolioId ? `\n\n_Folio activo: #${savedFolioId}_` : ""}`);
        } else {
          return await respond(`❌ PIN incorrecto. Inténtalo de nuevo.`);
        }
      }

      // Clear stale reauth flag if present but no longer needed
      if (isReauthPending && !isPinAttempt) {
        await this.updateState(phone, {
          state: convState.state,
          context: { ...convState.context, awaiting_reauth: false },
        });
      }
    }

    // ===== SMART GREETINGS + HELP MENU PER ROLE =====
    const isGreeting = /^(hola|hey|buenos? d[ií]as?|buenas? tardes?|buenas? noches?|buenas|qu[eé] tal|saludos|ey|hi|hello|mande)\s*[!.?]*$/i.test(body.trim());
    const isHelp = /^(ayuda|gu[ií]a|men[uú]|menu|comandos|que puedo hacer|qu[eé] puedo hacer|opciones|help)\s*[!.?]*$/i.test(body.trim());
    if ((isGreeting || isHelp) && !mediaUrl) {
      const hour = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" })).getHours();
      const timeGreet = hour >= 5 && hour < 12 ? "Buenos días" : hour >= 12 && hour < 18 ? "Buenas tardes" : "Buenas noches";
      const name = roleName || profileName || "";
      
      if (role === "director") {
        // Same structured menu as promotora + director-specific commands
        try {
          const { neon: neonDir } = await import("@neondatabase/serverless");
          const sqlDir = neonDir(process.env.DATABASE_URL!);
          const gRows = await sqlDir`
            SELECT o.id, o.folio, o.estado, o.updated_at, o.created_at,
              CONCAT(t.nombre, CASE WHEN t.apellido_paterno IS NOT NULL THEN ' ' || t.apellido_paterno ELSE '' END) as taxista_nombre,
              COUNT(d.id) FILTER (WHERE d.image_data IS NOT NULL OR d.ocr_result IS NOT NULL) as docs_count
            FROM originations o
            LEFT JOIN taxistas t ON t.id = o.taxista_id
            LEFT JOIN documents d ON d.origination_id = o.id
            WHERE o.estado NOT IN ('RECHAZADO', 'COMPLETADO', 'CANCELADO')
              AND (t.telefono IS NULL OR t.telefono NOT LIKE '521999%')
            GROUP BY o.id, o.folio, o.estado, o.updated_at, o.created_at, t.nombre, t.apellido_paterno
            ORDER BY o.updated_at ASC
          ` as any[];

          const lines: string[] = [`${timeGreet} ${name} 👋`];

          if (gRows.length > 0) {
            lines.push(``, `📋 *${gRows.length} trámite${gRows.length > 1 ? "s" : ""} activo${gRows.length > 1 ? "s" : ""}:*`);
            const MAX_SHOWN = 5;
            const toShow = gRows.slice(0, MAX_SHOWN);
            for (const r of toShow) {
              const n2 = r.taxista_nombre || r.folio;
              const days = Math.floor((Date.now() - new Date(r.updated_at || r.created_at).getTime()) / (1000*60*60*24));
              const daysStr = days > 0 ? ` (${days}d)` : "";
              lines.push(`• *${n2}*${daysStr}: ${parseInt(r.docs_count) || 0}/15 docs`);
            }
            if (gRows.length > MAX_SHOWN) {
              lines.push(`_... y ${gRows.length - MAX_SHOWN} más_`);
            }
          } else {
            lines.push(``, `No hay trámites activos.`);
          }

          lines.push(``, `¿Qué necesitas?`);
          lines.push(`1️⃣ Dudas del programa`);
          lines.push(`2️⃣ Nuevo prospecto`);
          lines.push(`3️⃣ Evaluar oportunidad`);
          lines.push(`4️⃣ Ver inventario`);
          lines.push(``, `📊 *Director:*`);
          lines.push(`• *números* — dashboard KPIs`);
          lines.push(`• *cartera* — créditos y mora`);
          lines.push(`• *mercado [modelo año]* — precios`);
          lines.push(`• *cierre* — cierre mensual`);
          lines.push(`• *auditar* — auditar expediente`);

          return await respond(lines.join("\n"));
        } catch (e: any) {
          console.error("[Director Greeting]", e.message);
          return await respond(`${timeGreet} ${name}. ¿En qué te ayudo?`);
        }
      }

      // ===== CLIENT CHECK (taxista with active credit in Airtable) =====
      if (role === "prospecto" || role === "unknown") {
        try {
          const { findClientByPhone, clientGreeting } = await import("./client-menu");
          const credit = await findClientByPhone(phone);
          if (credit) {
            console.log(`[Client] Found ${credit.type} credit for ${phone}: ${credit.folio}`);
            // Store client context for menu handlers
            await this.updateState(phone, { state: "client_menu" as any, context: { clientCredit: credit } } as any);
            return await respond(clientGreeting(credit, timeGreet));
          }
        } catch (e: any) {
          console.error("[Client] Lookup failed:", e.message);
        }
      }
      if (role === "promotora") {
        // Clear folio state on greeting — promotora starts fresh each "Hola"
        await this.updateState(phone, { state: "idle", folioId: null, context: {} });
        try {
          const { neon: neonProm } = await import("@neondatabase/serverless");
          const sqlProm = neonProm(process.env.DATABASE_URL!);
          const gRowsP = await sqlProm`
            SELECT o.id, o.folio, o.estado, o.updated_at, o.created_at,
              CONCAT(t.nombre, CASE WHEN t.apellido_paterno IS NOT NULL THEN ' ' || t.apellido_paterno ELSE '' END) as taxista_nombre,
              COUNT(d.id) FILTER (WHERE d.image_data IS NOT NULL OR d.ocr_result IS NOT NULL) as docs_count
            FROM originations o
            LEFT JOIN taxistas t ON t.id = o.taxista_id
            LEFT JOIN documents d ON d.origination_id = o.id
            WHERE o.estado NOT IN ('RECHAZADO', 'COMPLETADO', 'CANCELADO')
              AND (t.telefono IS NULL OR t.telefono NOT LIKE '521999%')
            GROUP BY o.id, o.folio, o.estado, o.updated_at, o.created_at, t.nombre, t.apellido_paterno
            ORDER BY o.updated_at ASC
          ` as any[];

          const linesP: string[] = [`${timeGreet} ${name} 👋`];
          if (gRowsP.length > 0) {
            linesP.push(``, `📋 *${gRowsP.length} trámite${gRowsP.length > 1 ? "s" : ""} activo${gRowsP.length > 1 ? "s" : ""}:*`);
            const MAX_SHOWN_P = 5;
            const toShowP = gRowsP.slice(0, MAX_SHOWN_P);
            for (const r of toShowP) {
              const n2 = r.taxista_nombre || r.folio;
              const days = Math.floor((Date.now() - new Date(r.updated_at || r.created_at).getTime()) / (1000*60*60*24));
              const daysStr = days > 0 ? ` (${days}d)` : "";
              linesP.push(`• *${n2}*${daysStr}: ${parseInt(r.docs_count) || 0}/15 docs`);
            }
            if (gRowsP.length > MAX_SHOWN_P) {
              linesP.push(`_... y ${gRowsP.length - MAX_SHOWN_P} más_`);
            }
          } else {
            linesP.push(``, `No hay trámites activos.`);
          }
          linesP.push(``, `¿Qué necesitas?`, `1️⃣ Dudas del programa`, `2️⃣ Nuevo prospecto`, `3️⃣ Buscar prospecto`, `4️⃣ Ver inventario`);
          return await respond(linesP.join("\n"));
        } catch (e: any) {
          console.error("[Promotora Greeting]", e.message);
          return await respond(`${timeGreet} ${name}. ¿En qué te ayudo?`);
        }
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
          greetLines.push(`\n\u00bfAlguna duda sobre tu cuenta o pagos?`);
          return await respond(greetLines.join("\n"));
        }
        // Cliente with folio: show status + next action
        const orig = originationId ? await this.storage.getOrigination(originationId) : null;
        if (orig) {
          const o = orig as any;
          const pI = await this.getPendingInfo(originationId!);
          return await respond(`${timeGreet} ${name}. Tu folio *${o.folio}* va en paso ${o.currentStep} de 8.\n\n${pI.count > 0 ? `Te falta: *${pI.text}*. \u00bfMe lo mandas?` : `Tu expediente est\u00e1 completo. \u00bfAlguna duda sobre tu tr\u00e1mite?`}`);
        }
        return await respond(`${timeGreet} ${name}. Soy el asistente de Conductores del Mundo. \u00bfEn qu\u00e9 te ayudo? Puedes enviarme documentos, preguntar sobre tu tr\u00e1mite o consultar tu estado de cuenta.`);
      }
      if (role === "prospecto") {
        // Prospecto: guide to fuel type question + track in pipeline
        // Reset any stale state from previous conversations
        const canal = detectCanal(body);
        try {
          await upsertProspect({ phone, canal_origen: canal, status: "curioso" });
        } catch (e: any) {
          console.error(`[Pipeline] upsertProspect FAILED for ${phone}:`, e.message);
        }
        await this.updateState(phone, { state: "prospect_fuel_type", context: { canal } });
        return await respond(`${timeGreet}${name ? " " + name : ""}. Soy el asistente de *Conductores del Mundo*. Tenemos un programa para renovar tu taxi con veh\u00edculo seminuevo y kit de gas natural. Gran parte del pago se cubre con tu ahorro en GNV.\n\n\u00bfTu taxi ya usa *gas natural* o est\u00e1s con *gasolina*?`);
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
      
      // ===== PENDING CORRIDA COMPLETA — intercept "Sí" before LLM =====
      const pendingCorrida = convState?.context?.pendingCorrida as string | undefined;
      if (pendingCorrida && /^\s*(s[ií]|yes|dale|ok|quer[oé]|ver|mu[eé]strame|cl?aro|andale|va)\s*[!.]*$/i.test(body || "")) {
        // Clear pendingCorrida from state
        await this.updateState(phone, {
          state: "evaluating",
          context: { ...convState?.context, pendingCorrida: null },
        });
        return await respond(pendingCorrida);
      }

      // ===== DIRECTOR SANDBOX MODE =====
      // Keywords that activate any flow in test mode (no real folio created)
      // Director can test any flow without affecting real data
      // Director escribiendo solo "prospecto", "entrevista", etc. (palabra exacta sola)
      // O con prefijo: "sandbox prospecto", "flujo entrevista", etc.
      // Sandbox mode: solo se activa con prefijo explícito "sandbox X" o "flujo X"
      // NUNCA intercepta palabras solas como "prospecto", "cliente" — esas son operaciones reales
      const sandboxPrefixMatch = lower.match(/^(?:sandbox|modo\s+test|test\s+flow|activar\s+flujo|flujo)\s+(\S+)(?:\s+.*)?$/i);
      const sandboxMatch = sandboxPrefixMatch;
      if (sandboxMatch) {
        const targetFlow = sandboxPrefixMatch![1].toLowerCase();
        const extra = "";
        const sandboxPhone = "+5210000000000";
        let msg = `*Sandbox* — activando flujo *${targetFlow}*`;
        if (extra) msg += ` (${extra})`;
        msg += `\n\n_Modo test: no se crean folios reales ni se envían mensajes al taxista._\n\n`;
        switch (targetFlow) {
          case "prospecto":
            msg += `Flujo prospecto iniciado.\nSimula: el taxista saluda por primera vez.\nRespuesta esperada: bienvenida + pregunta de nombre.`;
            break;
          case "entrevista":
            msg += `Flujo entrevista.\nPreguntas:\n1. Actividad/horario\n2. Servicios/cobro\n3. Ingreso diario\n4. Estructura chofer\n5. Gasto combustible\n6. Gastos vehículo\n7. Carga financiera\n8. Resiliencia`;
            break;
          case "documentos":
          case "documento":
            msg += `Flujo documentos (15 docs).\nEnvía una imagen — el agente la clasificará y validará en modo test.`;
            break;
          case "cliente":
            msg += `Flujo cliente (folio activo).\nSimula: taxista con contrato activo consulta su status.`;
            break;
          case "promotora":
            msg += `Flujo promotora.\nComandos disponibles: buscar folio, capturar doc, ver pendientes, iniciar entrevista.`;
            break;
          case "otp":
            msg += `Flujo OTP.\nSimula: envío + verificación de OTP.`;
            break;
          case "dev":
          case "proveedor":
            msg += `Flujo ${targetFlow}.\nAcceso completo a endpoints internos.`;
            break;
          default:
            msg += `Flujo desconocido. Opciones: prospecto, cliente, entrevista, documentos, promotora, otp, dev.`;
        }
        return await respond(msg);
      }

      // ===== DIRECTOR: OCR sin folio =====
      // Cualquier imagen sin folio activo → extrae y muestra, NO guarda
      // También responde a 'extrae', 'qué documento es', 'ocr', 'clasifica'
      const isOcrCommand = /^(extrae|qu[eé]\s+documento\s+es|clasifica|ocr|analiza\s+doc)(\s+.+)?$/i.test(lower);
      if (mediaUrl && (!originationId || isOcrCommand)) {
        try {
          const { classifyAndValidateDoc, DOC_ORDER: docOrder } = await import("./agent/vision");
          const imgBuf = await (await import("./twilio-helper")).downloadTwilioMedia(mediaUrl);
          const b64 = imgBuf.toString("base64");
          const result = await classifyAndValidateDoc(b64, "otro", docOrder, {});
          const ext = result.extracted_data || {};
          const flags = result.cross_check_flags || [];

          // Format fields in readable way
          const fieldLines = Object.entries(ext)
            .filter(([_, v]) => v !== null && v !== undefined && v !== "")
            .map(([k, v]) => `  *${k}*: ${v}`)
            .join("\n");

          const flagStr = flags.length > 0
            ? `\n\n⚠️ *Flags:* ${flags.join(", ")}`
            : "";

          const docLabel = result.detected_type
            ? docOrder.find((d: any) => d.key === result.detected_type)?.label || result.detected_type
            : "Desconocido";

          return await respond(
            `*${docLabel}* — sin folio (no guardado)\n\n` +
            (fieldLines || "Sin campos extraidos") +
            flagStr
          );
        } catch (e: any) {
          return await respond(`OCR fallido: ${e.message}`);
        }
      }

      // ===== DIRECTOR: "datos de [nombre]" / "ver expediente [folio]" =====
      const verExpedienteMatch = lower.match(/^(?:datos|expediente|ver|ocr\s+de)\s+(.+)/i);
      if (verExpedienteMatch && !mediaUrl) {
        const query = verExpedienteMatch[1].trim();
        try {
          const folio = await this.storage.findFolioFlexible(query);
          if (!folio || (Array.isArray(folio) && folio.length === 0)) {
            return await respond(`No encontré folio para "${query}".`);
          }
          const f = Array.isArray(folio) ? folio[0] : folio;
          const sql = (await import("@neondatabase/serverless")).neon(process.env.DATABASE_URL!);
          const rows = await sql`SELECT datos_ine, datos_csf, datos_comprobante, datos_concesion, datos_estado_cuenta, datos_historial, datos_factura, datos_membresia, interview_data FROM originations WHERE id = ${f.id}` as any[];
          if (!rows[0]) return await respond(`Folio ${f.folio} encontrado pero sin datos OCR aún.`);
          const r = rows[0];
          const summary = ([
            r.datos_ine ? `INE/Licencia: ${JSON.parse(r.datos_ine).nombre || JSON.parse(r.datos_ine).nombre_titular || '✓'}` : null,
            r.datos_csf ? `CSF/CURP/RFC: ✓` : null,
            r.datos_comprobante ? `Comprobante domicilio: ✓` : null,
            r.datos_concesion ? `Concesión/Circulación: ${JSON.parse(r.datos_concesion).numero_concesion || '✓'}` : null,
            r.datos_estado_cuenta ? `Estado de cuenta: ✓` : null,
            r.datos_historial ? `Historial GNV: ${JSON.parse(r.datos_historial).gnv_leq_mensual ? JSON.parse(r.datos_historial).gnv_leq_mensual + ' LEQ/mes' : '✓'}` : null,
            r.datos_factura ? `Factura: ✓` : null,
            r.interview_data ? `Entrevista: ✓ (coherencia: ${JSON.parse(r.interview_data).coherencia?.score || '?'})` : null,
          ] as (string | null)[]).filter(Boolean).join('\n');
          return await respond(`*Expediente ${f.folio}* — ${f.taxistaName || '?'}\n\n${summary || 'Sin datos capturados aún.'}`);
        } catch (e: any) {
          return await respond(`Error consultando expediente: ${e.message}`);
        }
      }

      // ===== VEHICLE ASSIGNMENT (director only) =====
      const asignaMatch = lower.match(/asign[ao]\s+(.+?)\s+(?:a|al|para)\s+(.+)/i);
      if (asignaMatch) {
        const vehicleQuery = asignaMatch[1].trim();
        const folioQuery = asignaMatch[2].trim();
        try {
          // Find vehicle in inventory
          const allVehicles = await this.storage.listVehicles();
          const available = allVehicles.filter((v: any) => v.status === "disponible");
          const matchedVehicle = available.find((v: any) => {
            const vText = `${v.marca} ${v.modelo} ${v.variante || ""} ${v.anio}`.toLowerCase();
            return vehicleQuery.split(/\s+/).every((w: string) => vText.includes(w.toLowerCase()));
          });
          if (!matchedVehicle) {
            const availList = available.map((v: any) => `- ${v.marca} ${v.modelo} ${v.anio} (ID ${v.id})`).join("\n");
            return await respond(`No encontr\u00e9 veh\u00edculo disponible con "${vehicleQuery}".\n\nDisponibles:\n${availList}`);
          }

          // Find folio
          const folio = await this.storage.findFolioFlexible(folioQuery);
          if (!folio) {
            return await respond(`No encontr\u00e9 folio para "${folioQuery}". Verifica el nombre o n\u00famero.`);
          }
          if (Array.isArray(folio)) {
            return await respond(`Encontr\u00e9 ${folio.length} folios. S\u00e9 m\u00e1s espec\u00edfico:\n${folio.map((f: any) => `- ${f.folio}: ${f.taxistaName || "?"}`).join("\n")}`);
          }

          const f = folio as any;
          if (f.vehicleInventoryId) {
            return await respond(`El folio ${f.folio} ya tiene veh\u00edculo asignado (ID ${f.vehicleInventoryId}). \u00bfQuieres reasignar?`);
          }

          // Execute assignment
          await this.storage.updateOrigination(f.id, { vehicleInventoryId: matchedVehicle.id });
          await this.storage.updateVehicle(matchedVehicle.id, { status: "asignado" });

          const { logAudit } = await import("./audit-trail");
          logAudit({ action: "VEHICLE_UPDATED", actor: "director", role: "director", target_type: "vehicle", target_id: String(matchedVehicle.id), details: `Asignado a folio ${f.folio}` }).catch(() => {});

          return await respond(`Asignado:\n*${matchedVehicle.marca} ${matchedVehicle.modelo} ${matchedVehicle.anio}* (ID ${matchedVehicle.id})\n\u2192 Folio *${f.folio}* (${f.taxistaName || "?"})\n\nVeh\u00edculo marcado como "asignado". El folio puede avanzar al paso de contrato.`);
        } catch (err: any) {
          return await respond(`Error al asignar: ${err.message}`);
        }
      }

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

      // ===== DIRECTOR: EVAL PARSER (same as promotora) =====
      const cmd = body.replace(/^josu[eé]\s*/i, "").trim();
      const dirEarlyParsed = this.parseEvalLine(cmd);
      const dirEvalSignals = dirEarlyParsed.cost || dirEarlyParsed.repair || lower.startsWith("evalua") || lower.startsWith("eval\u00faa");
      const dirIsConversational = /(?:conviene|vale la pena|crees|opinas|recomiendas|tomando en cuenta|considerando|los (?:dos|tres|ultimos)|ambos|comparando|que piensas|deber[i\u00ed]a|me sale|es buena|buena opci[o\u00f3]n|qu[e\u00e9] tal si)/i.test(lower);
      if (dirEvalSignals && !dirIsConversational) {
        let dModel: any;
        if (dirEarlyParsed.modelQuery) dModel = await this.resolveModel(dirEarlyParsed.modelQuery, dirEarlyParsed.year);
        if (dModel && dirEarlyParsed.cost) {
          // Run eval directly
          const mkt = await this.fetchMarketPrices(dModel.brand, dModel.model, dirEarlyParsed.year || dModel.year, dModel.variant);
          const fuel = await this.getFuel();
          const mData = { brand: dModel.brand, model: dModel.model, variant: dModel.variant, slug: dModel.slug, purchaseBenchmarkPct: dModel.purchaseBenchmarkPct || 0.60 };
          const input = { modelId: dModel.id, modelSlug: dModel.slug, year: dirEarlyParsed.year || dModel.year, cmu: dModel.cmu, insurerPrice: dirEarlyParsed.cost, repairEstimate: dirEarlyParsed.repair || 0, conTanque: dirEarlyParsed.conTanque ?? true };
          const rules = await this.getRules();
          const result = evaluateOpportunity(input, mData, { gnvRevenue: fuel.gnvRevenueMes, marketAvgPrice: mkt.avg, marketP70: mkt.p70 });
          return await respond(this.formatEvalResult(result, mkt, fuel.gnvRevenueMes, getThresholds(rules)));
        }
      }

      // ===== DIRECTOR MENU OPTIONS (same as promotora) =====
      if (lower === "1" || /^dudas?$/i.test(lower)) {
        return await respond(`*Temas frecuentes:*\n\n\u2022 *requisitos* \u2014 15 documentos + vigencias\n\u2022 *proceso* \u2014 paso a paso del tr\u00e1mite\n\u2022 *kit* \u2014 kit GNV incluido\n\u2022 *enganche* \u2014 anticipo y d\u00eda 56\n\u2022 *cuota* \u2014 c\u00f3mo funciona la amortizaci\u00f3n\n\u2022 *fondo de garant\u00eda* \u2014 FG y mora\n\u2022 *gas* \u2014 estaciones, ahorro, bicombustible\n\u2022 *seguro* \u2014 responsabilidad del taxista\n\u2022 *firma* \u2014 contrato digital o presencial\n\nEscribe cualquier tema o pregunta directa.`);
      }
      if (lower === "2" || /^nuevo$/i.test(lower)) {
        await this.updateState(phone, { state: "waiting_folio_name" as any, folio_id: null, context: {} });
        return await respond("Nombre del taxista y tel\u00e9fono:\nEjemplo: *Pedro L\u00f3pez 4491234567*");
      }
      if (lower === "3" || /^evaluar$/i.test(lower)) {
        return await respond(`Para evaluar, escribe el modelo con precio y reparaci\u00f3n:\n\n*march 120k rep 10k*\n*aveo 100k 0 rep*\n*vento 2020 150k rep 5k*\n\nTambi\u00e9n puedes pedir precios de mercado:\n*mercado march 2021*`);
      }
      if (lower === "4" || /(?:inventario|veh[i\u00ed]culos?\s+(?:disponibles?|tenemos)|carros?\s+(?:disponibles?|tenemos)|qu[e\u00e9]\s+(?:hay|tienen))/i.test(lower)) {
        try {
          const { neon: neonInv2 } = await import("@neondatabase/serverless");
          const sqlI2 = neonInv2(process.env.DATABASE_URL!);
          const inv2 = await sqlI2`SELECT brand, model, variant, year, cmu AS cmu_valor, status FROM vehicles_inventory WHERE status = 'disponible' ORDER BY brand, model, year` as any[];
          if (inv2.length === 0) return await respond("No hay veh\u00edculos disponibles.");
          const lines2 = [`\ud83d\ude97 *Inventario CMU* (${inv2.length} disponibles):`, ``];
          for (const v of inv2) {
            lines2.push(`\u2022 *${v.brand} ${v.model}${v.variant ? " " + v.variant : ""} ${v.year}* \u2014 $${Number(v.cmu_valor).toLocaleString()}`);
          }
          lines2.push(``, `Dime el modelo y te calculo la cuota.`);
          return await respond(lines2.join("\n"));
        } catch (e: any) { console.error("[Inventario Dir]", e.message); }
      }
      // Auditar expediente
      if (/^(?:auditar|validar|verificar|check)\s*(?:expediente)?/i.test(lower)) {
        try {
          const { neon: neonAudit2 } = await import("@neondatabase/serverless");
          const sqlA2 = neonAudit2(process.env.DATABASE_URL!);
          const folios2 = await sqlA2`
            SELECT o.id, o.folio, o.estado, CONCAT(t.nombre, ' ', t.apellido_paterno) as nombre
            FROM originations o LEFT JOIN taxistas t ON t.id = o.taxista_id
            WHERE o.estado NOT IN ('RECHAZADO','CANCELADO') AND (t.telefono IS NULL OR t.telefono NOT LIKE '521999%')
            ORDER BY o.updated_at DESC LIMIT 5
          ` as any[];
          if (folios2.length === 0) return await respond("No hay expedientes activos.");
          if (folios2.length > 1) {
            const list2 = folios2.map((f: any, i: number) => `${i+1}. *${f.folio}* \u2014 ${f.nombre || '?'} (${f.estado})`).join('\n');
            return await respond(`\u00bfCu\u00e1l expediente auditar?\n\n${list2}\n\nEscribe *auditar [folio]*`);
          }
          const cs2 = await sqlA2`SELECT context FROM conversation_states WHERE folio_id = ${folios2[0].id} LIMIT 1` as any[];
          const ctx2 = cs2[0]?.context ? (typeof cs2[0].context === 'string' ? JSON.parse(cs2[0].context) : cs2[0].context) : {};
          const { auditExpediente } = await import("./agent/post-ocr-validation");
          const audit2 = auditExpediente(ctx2.existingData || {});
          return await respond(`${audit2.summary}\n\n_Folio: ${folios2[0].folio} \u2014 ${folios2[0].nombre}_`);
        } catch (e: any) { return await respond(`Error: ${e.message}`); }
      }

      // ===== DIRECTOR: deterministic command handlers (before RAG/LLM) =====
      if (/^(?:documentos?|docs?|papeles?|cu[aá]les\s+(?:son\s+)?(?:los\s+)?doc|dame\s+(?:los\s+)?doc|lista\s+(?:de\s+)?doc|requisitos?\s+doc)/i.test(lower)) {
        const docList = DOC_ORDER.map((d, i) => `${i + 1}. ${d.label}`).join('\n');
        return await respond(`📋 *15 documentos requeridos:*\n\n${docList}\n\n+ Entrevista de 8 preguntas\n\n_Escribe *requisitos* para ver vigencias y detalles._`);
      }

      if (isCanalCDirect || isCsvOrExcelMedia || (!mediaUrl && !originationId)) {
        // RAG first: check FAQ/knowledge base before LLM (prevents hallucinated answers)
        if (body && !isCsvOrExcelMedia) {
          try {
            const { answerQuestion } = await import("./agent/rag");
            const ragAnswer = await answerQuestion(body);
            if (ragAnswer) return await respond(ragAnswer);
          } catch (e: any) {
            console.error("[RAG Director]", e.message);
          }
        }
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
                const josuePhone = JOSUE_PHONE;
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

    // ===== VOICE NOTE: Transcribe with Whisper and treat as text =====
    if (mediaUrl && mediaType && (mediaType.includes("audio") || mediaType.includes("ogg") || mediaType.includes("opus"))) {
      try {
        const SID = process.env.TWILIO_ACCOUNT_SID;
        const TOK = process.env.TWILIO_AUTH_TOKEN;
        const audioResp = await fetch(mediaUrl, {
          headers: SID && TOK ? { "Authorization": "Basic " + Buffer.from(`${SID}:${TOK}`).toString("base64") } : {},
        });
        const audioBuf = Buffer.from(await audioResp.arrayBuffer());
        console.log(`[Agent] Voice note received: ${(audioBuf.length / 1024).toFixed(1)}KB, type=${mediaType}`);

        const { transcribirAudio } = await import("./evaluacion-taxi");
        const result = await transcribirAudio(audioBuf, "whatsapp-voice");

        if (result.transcript && result.transcript.trim().length > 0) {
          console.log(`[Agent] Whisper transcript: "${result.transcript.substring(0, 100)}"`);
          body = result.transcript;
          mediaUrl = null;
          mediaType = null;
          // Fall through to normal text handling below
        } else {
          return await respond("No pude entender el audio. \u00bfPuedes repetir o escribir tu mensaje?");
        }
      } catch (err: any) {
        console.error(`[Agent] Voice transcription error:`, err.message);
        return await respond("Hubo un problema al procesar tu nota de voz. Int\u00e9ntalo de nuevo o escr\u00edbeme.");
      }
    }

    // ===== WHATSAPP INTERVIEW (voice notes) =====
    if (body && (role === "cliente" || role === "promotora")) {
      const interviewState = await this.getConvState(phone);
      
      // Check if we're in an active interview
      if (interviewState.state?.startsWith("interview_q")) {
        const { processAnswer, InterviewState } = await import("./entrevista-whatsapp");
        const iState: any = interviewState.context?.interview;
        if (iState) {
          const result = await processAnswer(
            iState,
            body, // already transcribed if voice note
            0,
            (msgs, maxT) => this.llm(msgs, maxT),
          );

          if (result.isComplete) {
            await this.updateState(phone, { state: "idle", context: {} });
            // Notify director
            const { DIRECTOR } = await import("./team-config");
            const notifMsg = `*Entrevista completada por WhatsApp*\nFolio: ${iState.folioId}\nDecisi\u00f3n motor: ${result.evaluation?.coherencia?.decision}\nScore: ${result.evaluation?.coherencia?.score_coherencia}\nFlujo libre: $${Math.round(result.evaluation?.coherencia?.flujo_libre_mes || 0).toLocaleString()}\n\nRevisa en el panel de Evaluaciones.`;
            fetch("http://localhost:5000/api/whatsapp/send-outbound", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ to: `whatsapp:+${DIRECTOR.phone}`, body: notifMsg }),
            }).catch(() => {});
            return await respond(result.reply);
          } else {
            await this.updateState(phone, {
              state: `interview_q${result.newState.currentQuestion}`,
              context: { interview: result.newState },
            });
            return await respond(result.reply);
          }
        }
      }

      // Trigger interview if docs_completo and promotora/agent says to start
      // Bug fix: accept just "entrevista" as trigger — promotora no necesita decir "iniciar entrevista"
      const wantsInterview = /\bentrevista\b|iniciar entrevista|empezar entrevista|hacer entrevista|entrevista.*whatsapp|evaluar.*whatsapp/i.test(body.toLowerCase());
      if (wantsInterview && !originationId) {
        // No folio activo — pedir que seleccione primero
        return await respond("\u00bfPara qué folio? Dime el nombre del taxista.");
      }
      if (wantsInterview && originationId) {
        const orig = await this.storage.getOrigination(originationId);
        const folioStr = (orig as any)?.folio || `FOL-${originationId}`;
        const taxistaName = (orig as any)?.taxistaName || (convState?.context as any)?.folio?.taxistaName || "el taxista";
        const { getCurrentQuestion } = await import("./entrevista-whatsapp");
        const iState = {
          folioId: folioStr,
          currentQuestion: 0,
          answers: {},
          transcripts: [],
        };
        await this.updateState(phone, {
          state: "interview_q0",
          context: { interview: iState },
        });
        const q1 = getCurrentQuestion(iState);
        // Promotora-specific intro: she is conducting, not answering
        const intro = `Iniciando entrevista para *${taxistaName}* (${folioStr}).\n\nHaz las siguientes preguntas al taxista y escribe (o manda nota de voz con) sus respuestas.\n\n`;
        return await respond(`${intro}${q1}`);
      }
    }

    // ===== PERMISSION CHECK: Prospecto media handling =====
    if (role === "prospecto" && mediaUrl) {
      // Check if prospect has a folio (is in docs capture state)
      const pState = await this.getConvState(phone);
      if (pState.folioId) {
        // Has folio — let the doc handler below process it
        originationId = pState.folioId;
        console.log(`[Agent] Prospect ${phone} sending doc, folio=${originationId}`);
      } else {
        // No folio yet — guide them through the flow first
        return await respond("Primero necesito registrarte. \u00bfTu taxi ya usa *gas natural* o est\u00e1s con *gasolina*?", null, null);
      }
    }

    // ===== CANAL A/B SHARED LOGIC =====
    let docSaved: string | null = null;
    let visionNote: string | null = null;
    let flexSearchNote: string | null = null;
    let simulationData: string | null = null;

    // Flexible folio search (for promotora and director)
    // Skip if we're waiting for a new folio name (waiting_folio_name state)
    if (!mediaUrl && body && !originationId && (role === "promotora" || role === "director") && convState?.state !== "waiting_folio_name") {
      const results = await this.findFolio(body.trim());
      if (results[0] && results.length === 1) {
        originationId = results[0].id;
        flexSearchNote = `[FOLIO] ${results[0].folio}${results[0].taxistaName ? ` de ${results[0].taxistaName}` : ""}`;
        await this.updateState(phone, {
          folioId: originationId,
          state: "capturing_docs",
          context: { folio: { id: originationId, folio: results[0].folio, estado: "CAPTURANDO", step: 0, docsCapturados: [], docsPendientes: [], taxistaName: results[0].taxistaName || undefined } },
        });
        // Para promotora: respuesta conversacional inmediata (no esperar al LLM)
        if (role === "promotora") {
          const tName = results[0].taxistaName || results[0].folio;
          const pInfo = await this.getPendingInfo(originationId);
          if (pInfo.count === 0) {
            return await respond(`El trámite de ${tName} está completo. ¿Hacemos la entrevista ahora?`);
          }
          const nextDoc = pInfo.nextKey ? (DOC_LABELS[pInfo.nextKey] || pInfo.nextKey) : null;
          return await respond(`El trámite de ${tName} lleva ${14 - pInfo.count} de 14 papeles.\n\n${nextDoc ? `Falta empezar con: *${nextDoc}*. ¿Me mandas la foto?` : `Le faltan: ${pInfo.text}.`}`);
        }
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

      // Nuevo folio / nuevo prospecto from promotor
      // Siempre limpia el folio activo primero para no contaminar con contexto anterior
      if (/^nuevo\s+(folio|prospecto|cliente|taxista)\s*$/i.test(body.trim())) {
        await this.updateState(phone, { state: "waiting_folio_name", folio_id: null, context: {} });
        originationId = null;
        return await respond("Nombre del taxista y teléfono:\nEjemplo: *Pedro López 4491234567*");
      }
      if (/quiero\s+(generar|crear|registrar|agregar|dar\s+de\s+alta)\s+(un\s+)?(nuevo\s+)?(prospecto|folio|cliente|taxista)/i.test(body.trim())) {
        await this.updateState(phone, { state: "waiting_folio_name", folio_id: null, context: {} });
        originationId = null;
        return await respond("Nombre del taxista y teléfono:\nEjemplo: *Pedro López 4491234567*");
      }
      // Estado waiting_folio_phone: Ángeles ya dio el nombre, ahora da el teléfono
      if (convState?.state === "waiting_folio_phone" && body) {
        const phoneMatchP = body.match(/(\d{10,13})/);
        const taxistaPhoneP = phoneMatchP ? phoneMatchP[1] : "";
        const taxistaNameP = (convState?.context as any)?.pendingName || "Sin nombre";
        if (!taxistaPhoneP) {
          return await respond(`Necesito el teléfono de ${taxistaNameP}. Ejemplo: *4491234567*`);
        }
        await this.updateState(phone, { state: "idle", context: {} });
        try {
          const result = await createFolioFromWhatsApp(this.storage, phone, taxistaNameP, taxistaPhoneP);
          originationId = result.originationId;
          await this.updateState(phone, { folioId: result.originationId, state: "capturing_docs", context: { folio: { id: result.originationId, folio: result.folio, estado: "BORRADOR", step: 1, docsCapturados: [], docsPendientes: DOC_ORDER.map((d: any) => d.key), taxistaName: taxistaNameP } } });
          return await respond(`Listo, ya registré a ${taxistaNameP}.\n\nMandáme foto del frente de su INE.`);
        } catch (e: any) {
          return await respond(`No pude crear el expediente: ${e.message}`);
        }
      }

      // Estado waiting_folio_name: siguiente mensaje = nombre + tel
      if (convState?.state === "waiting_folio_name" && body && !/^nuevo\s+(folio|prospecto)/i.test(body)) {
        const phoneMatchWait = body.match(/(\d{10,13})/);
        const taxistaPhoneWait = phoneMatchWait ? phoneMatchWait[1] : "";
        const taxistaNameWait = body.replace(/\d{10,13}/, "").trim() || "Sin nombre";
        if (!taxistaPhoneWait) {
          // Guardó el nombre, ahora pide el teléfono naturalmente
          await this.updateState(phone, { state: "waiting_folio_phone", context: { ...convState?.context, pendingName: taxistaNameWait } });
          return await respond(`¿Y el teléfono de ${taxistaNameWait}?`);
        }
        await this.updateState(phone, { state: "idle", context: { ...convState?.context } });
        try {
          const result = await createFolioFromWhatsApp(this.storage, phone, taxistaNameWait, taxistaPhoneWait);
          originationId = result.originationId;
          await this.updateState(phone, { folioId: result.originationId, state: "capturing_docs", context: { folio: { id: result.originationId, folio: result.folio, estado: "BORRADOR", step: 1, docsCapturados: [], docsPendientes: DOC_ORDER.map((d: any) => d.key), taxistaName: taxistaNameWait } } });
          return await respond(`Folio creado: *${result.folio}*\n${taxistaNameWait} | ${taxistaPhoneWait}\n\nEnvía los documentos. Primero: *INE (frente y vuelta)*`);
        } catch (e: any) {
          return await respond(`Error al crear folio: ${e.message}`);
        }
      }
      const nuevoFolioMatch = body.match(/^nuevo\s+folio\s+(.+)/i);
      if (nuevoFolioMatch) {
        const args = nuevoFolioMatch[1].trim();
        const phoneMatch = args.match(/(\d{10,13})/);
        const taxistaPhone = phoneMatch ? phoneMatch[1] : "";
        const taxistaName = args.replace(/\d{10,13}/, "").trim() || "Sin nombre";
        if (!taxistaPhone) {
          await this.updateState(phone, { state: "waiting_folio_name", context: { ...convState?.context, pendingName: taxistaName } });
          return await respond(`Teléfono de ${taxistaName}:`);
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

      // Send message to taxista from promotor — ONLY explicit send commands
      // "mándale", "sí mándale", "envíale mensaje", "agendar entrevista", "manda recordatorio"
      // A bare "sí" does NOT trigger this — it must include a send verb
      const explicitSend = /m[aá]ndale|env[ií]ale|agendar.*entrevista|manda.*mensaje|manda.*recordatorio|recordarle|s[ií].*m[aá]nda|dale.*m[aá]nda/i.test(lower);
      if (explicitSend && originationId) {
        try {
          const orig = await this.storage.getOrigination(originationId);
          if (orig) {
            const o = orig as any;
            const tid = o.taxistaId || o.taxista_id;
            const taxista = tid ? await this.storage.getTaxista(tid) : null;
            const taxistaPhone = taxista ? (taxista as any).telefono || (taxista as any).phone : null;
            const taxistaName = taxista ? (taxista as any).nombre : "taxista";
            if (taxistaPhone) {
              const step = o.currentStep || 1;
              let msgToClient = "";
              if (step <= 2) {
                // Needs docs
                const allDocs = await this.storage.getDocumentsByOrigination(originationId);
                const captured = new Set(allDocs.filter((d: any) => d.imageData || d.image_data).map((d: any) => d.tipo));
                const pending = DOC_ORDER.filter(d => !captured.has(d.key)).slice(0, 3).map(d => d.label);
                msgToClient = `Hola ${taxistaName.split(" ")[0]}. Para avanzar con tu tr\u00e1mite en CMU necesitamos: *${pending.join(", ")}*. \u00bfMe los puedes mandar por aqu\u00ed?`;
              } else if (step === 2 || step === 3) {
                // Needs interview
                msgToClient = `Hola ${taxistaName.split(" ")[0]}. Tu expediente va bien. Para continuar necesitamos una entrevista presencial con tu asesora \u00c1ngeles. \u00bfQu\u00e9 d\u00eda te queda bien esta semana?`;
              } else {
                msgToClient = `Hola ${taxistaName.split(" ")[0]}. Tu tr\u00e1mite en CMU va en paso ${step} de 8. \u00bfTienes alguna duda?`;
              }
              const cleanPhone = taxistaPhone.replace(/\D/g, "");
              await fetch("http://localhost:5000/api/whatsapp/send-outbound", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ to: `whatsapp:+${cleanPhone}`, body: msgToClient }),
              });
              return await respond(`Listo, le mand\u00e9 mensaje a ${taxistaName} (${cleanPhone}).`);
            } else {
              return await respond(`No tengo el tel\u00e9fono del taxista de este folio.`);
            }
          }
        } catch (e: any) {
          return await respond(`Error al enviar: ${e.message}`);
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
              `Mes actual: ${credit["Mes Actual"] || 0} de 36`,
              `Cuota actual: $${(credit["Cuota Actual"] || 0).toLocaleString()}`,
              `Saldo capital: $${(credit["Saldo Capital"] || 0).toLocaleString()}`,
              `Fondo de Garantía: $${(credit["Saldo FG"] || 0).toLocaleString()}/20,000`,
            ];
            if ((credit["Dias Atraso"] || 0) > 0) {
              lines.push(`⚠️ Días de atraso: ${credit["Dias Atraso"]}`);
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

    // ===== PROSPECT: Guided state machine (v2 — agente owns full funnel) =====
    if (body && role === "prospecto") {
      const lower = body.toLowerCase();
      const prospectState = await this.getConvState(phone);

      // If no state yet (first message, e.g. from QR scan), start the prospect flow
      if (!prospectState.state || prospectState.state === "idle") {
        const canal = detectCanal(body);
        try { await upsertProspect({ phone, canal_origen: canal, status: "curioso" }); }
        catch (e: any) { console.error(`[Pipeline] upsertProspect:`, e.message); }
        await this.updateState(phone, { state: "prospect_fuel_type", context: { canal } });
        const hour = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" })).getHours();
        const timeGreet = hour >= 5 && hour < 12 ? "Buenos d\u00edas" : hour >= 12 && hour < 18 ? "Buenas tardes" : "Buenas noches";
        const name = profileName || "";
        return await respond(`${timeGreet}${name ? " " + name : ""}. Soy el asistente de *Conductores del Mundo*. Tenemos un programa para renovar tu taxi con veh\u00edculo seminuevo y kit de gas natural. Gran parte del pago se cubre con tu ahorro en GNV.\n\n\u00bfTu taxi ya usa *gas natural* o est\u00e1s con *gasolina*?`);
      }

      // Helper: send notification to Josué + promotor
      const notifyTeam = async (msg: string) => {
        // Suppress notifications for test phones (521999*)
        if (/521999/.test(msg) || /521999/.test(phone)) {
          console.log('[Notify] SUPPRESSED (test phone):', msg.slice(0, 60));
          return;
        }
        const endpoints = [
          { to: `whatsapp:+${JOSUE_PHONE}` },  // Josué
          { to: `whatsapp:+${getPromotor()?.phone || ANGELES_PHONE}` },  // Promotor
        ];
        for (const ep of endpoints) {
          try {
            await fetch("http://localhost:5000/api/whatsapp/send-outbound", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...ep, body: msg }),
            });
          } catch (e: any) {
            console.error(`[Notify] Failed to send to ${ep.to}:`, e.message);
          }
        }
      };

      // ── State: prospect_fuel_type — ¿gas natural o gasolina? ──
      if (prospectState.state === "prospect_fuel_type") {
        const isGNV = /gas\s*natural|gnv|gas$|ya.*gas|s[ií].*gas|con gas/i.test(lower);
        const isGasolina = /gasolina|magna|premium|normal|no.*gas|sin gas/i.test(lower);
        if (isGNV) {
          await this.updateState(phone, { state: "prospect_gnv_consumo", context: { ...prospectState.context, fuelType: "gnv" } });
          return await respond("Perfecto, ya est\u00e1s con gas natural. \u00bfM\u00e1s o menos cu\u00e1ntos litros cargas al mes? Un aproximado est\u00e1 bien.");
        } else if (isGasolina) {
          await this.updateState(phone, { state: "prospect_gasolina_gasto", context: { ...prospectState.context, fuelType: "gasolina" } });
          return await respond("\u00bfCu\u00e1nto gastas de gasolina al mes, m\u00e1s o menos? Con eso te calculo cu\u00e1nto ahorrar\u00edas con gas natural.");
        }
      }

      // ── State: prospect_gnv_consumo — ¿cuántos LEQ/mes? ──
      if (prospectState.state === "prospect_gnv_consumo") {
        const numMatch = lower.match(/(\d{2,4})/);
        if (numMatch) {
          const leq = parseInt(numMatch[1]);
          const recaudo = leq * 11;
          await this.updateState(phone, { state: "prospect_show_models", context: { ...prospectState.context, leqMes: leq, recaudo } });
          try { await upsertProspect({ phone, status: "interesado", fuel_type: "gnv", consumo_mensual: leq, ahorro_estimado: recaudo }); }
          catch (e: any) { console.error(`[Pipeline] upsertProspect:`, e.message); }
          // Show 5 models with real numbers
          const resumen = await generarResumen5Modelos(leq);
          return await respond(resumen);
        }
      }

      // ── State: prospect_gasolina_gasto — ¿cuánto gastas en gasolina? ──
      if (prospectState.state === "prospect_gasolina_gasto") {
        const numMatch = lower.match(/(\d{3,5})/);
        if (numMatch) {
          const fuel = await this.getFuel();
          const gastoGasolina = parseInt(numMatch[1]);
          const ltEquiv = Math.round(gastoGasolina / fuel.gasolinaPrice);
          const recaudo = ltEquiv * 11;
          await this.updateState(phone, { state: "prospect_show_models", context: { ...prospectState.context, leqMes: ltEquiv, recaudo, gastoGasolina } });
          try { await upsertProspect({ phone, status: "interesado", fuel_type: "gasolina", consumo_mensual: ltEquiv, ahorro_estimado: recaudo }); }
          catch (e: any) { console.error(`[Pipeline] upsertProspect:`, e.message); }
          const resumen = await generarResumen5Modelos(ltEquiv);
          const gastoGNV = Math.round(ltEquiv * fuel.gnvPrice);
          const ahorro = gastoGasolina - gastoGNV;
          return await respond(`Gastas *$${gastoGasolina.toLocaleString()}/mes* en gasolina. Con GNV gastar\u00edas *$${gastoGNV.toLocaleString()}* \u2014 ahorro de *$${ahorro.toLocaleString()}/mes*.\n\n${resumen}`);
        }
      }

      // ── State: prospect_show_models — waiting for model selection ──
      if (prospectState.state === "prospect_show_models" || prospectState.state === "prospect_select_model") {
        const matched = matchModelFromText(lower);
        if (matched) {
          const consumo = prospectState.context?.leqMes || 400;
          const pv = await getPvForModel(matched.marca, matched.modelo, matched.anio);
          const fuelType = prospectState.context?.fuelType || "gnv";
          
          // If Perfil A (GNV) → ask about tank reuse
          if (fuelType === "gnv") {
            await this.updateState(phone, { state: "prospect_tank_question", context: { ...prospectState.context, modelo: matched, pv } });
            return await respond(`*${matched.marca} ${matched.modelo} ${matched.anio}* \u2014 $${pv.toLocaleString()}\n\nAntes de darte los n\u00fameros: \u00bftu tanque de GNV est\u00e1 en buen estado para reusarlo? Reusarlo no tiene costo extra. Equipo nuevo suma $9,400 al precio.\n\n1\uFE0F\u20E3 *Reuso mi tanque* (sin costo)\n2\uFE0F\u20E3 *Equipo nuevo* (+$9,400)`);
          } else {
            // Perfil B (gasolina) → ask about tank too (they may already have one installed)
            await this.updateState(phone, { state: "prospect_tank_question", context: { ...prospectState.context, modelo: matched, pv } });
            return await respond(`*${matched.marca} ${matched.modelo} ${matched.anio}* \u2014 $${pv.toLocaleString()}\n\n\u00bfTu taxi ya tiene instalado un tanque de GNV? Si lo tiene y est\u00e1 en buen estado, no tiene costo extra.\n\n1\uFE0F\u20E3 *S\u00ed, ya tengo tanque* (sin costo)
2\uFE0F\u20E3 *No tengo tanque* (+$9,400)`);
          }
        }
        // Didn't match — show models again
        if (/cu[aá]l|modelo|ver|opciones|otro/i.test(lower)) {
          const resumen = await generarResumen5Modelos(prospectState.context?.leqMes || 400);
          return await respond(resumen);
        }
      }

      // ── State: prospect_tank_question — ¿reusa tanque o equipo nuevo? (solo Perfil A) ──
      if (prospectState.state === "prospect_tank_question") {
        const reusa = /reuso|reusar|1|mi tanque|el m[ií]o|s[ií]|actual|mismo/i.test(lower);
        const nuevo = /nuevo|2|equipo nuevo|completo|todo nuevo/i.test(lower);
        const modelo = prospectState.context?.modelo as any;
        const pvBase = prospectState.context?.pv || 200000;
        const consumo = prospectState.context?.leqMes || 400;
        
        if (reusa || nuevo) {
          const kitNuevo = nuevo;
          const pvFinal = kitNuevo ? pvBase + 9400 : pvBase;
          const corrida = generarCorridaEstimada(`${modelo.marca} ${modelo.modelo}`, modelo.anio, pvFinal, consumo);
          await this.updateState(phone, { state: "prospect_post_corrida", context: { ...prospectState.context, pv: pvFinal, kitNuevo } });
          const kitLabel = kitNuevo ? "(equipo GNV nuevo +$9,400)" : "(reusas tu tanque)";
          return await respond(`${corrida.resumenWhatsApp}\n${kitLabel}\n\n\u00bfQuieres empezar el proceso? Solo necesito tu nombre.`);
        }
      }

      // ── State: prospect_post_corrida — vio la corrida, ¿quiere empezar? ──
      if (prospectState.state === "prospect_post_corrida") {
        const isPositive = /s[ií]|va|dale|le entro|me interesa|me apunto|quiero|inscri|registr|adelante|ok|va pues|c[oó]mo|nombre|empez/i.test(lower);
        const wantsOther = /otro|diferente|cambiar|ver otro/i.test(lower);
        if (wantsOther) {
          await this.updateState(phone, { state: "prospect_show_models", context: prospectState.context });
          const resumen = await generarResumen5Modelos(prospectState.context?.leqMes || 400);
          return await respond(`Claro, aqu\u00ed est\u00e1n de nuevo:\n\n${resumen}`);
        }
        // Check if they also matched a model name (want to see another specific one)
        const matched = matchModelFromText(lower);
        if (matched) {
          await this.updateState(phone, { state: "prospect_show_models", context: prospectState.context });
          // Re-trigger model selection
          const consumo = prospectState.context?.leqMes || 400;
          const pv = await getPvForModel(matched.marca, matched.modelo, matched.anio);
          const fuelType = prospectState.context?.fuelType || "gnv";
          if (fuelType === "gnv") {
            await this.updateState(phone, { state: "prospect_tank_question", context: { ...prospectState.context, modelo: matched, pv } });
            return await respond(`*${matched.marca} ${matched.modelo} ${matched.anio}* \u2014 $${pv.toLocaleString()}\n\n\u00bfReusas tu tanque de GNV o equipo nuevo (+$9,400)?`);
          } else {
            const pvFinal = pv + 9400;
            const corrida = generarCorridaEstimada(`${matched.marca} ${matched.modelo}`, matched.anio, pvFinal, consumo);
            await this.updateState(phone, { state: "prospect_post_corrida", context: { ...prospectState.context, modelo: matched, pv: pvFinal } });
            return await respond(corrida.resumenWhatsApp + "\n\n\u00bfQuieres empezar? Solo necesito tu nombre.");
          }
        }
        if (isPositive) {
          await this.updateState(phone, { state: "prospect_awaiting_name", context: prospectState.context });
          return await respond("\u00bfC\u00f3mo te llamas? (nombre completo)");
        }
        const isNegative = /no|nel|nah|luego|despu[eé]s|lo pienso|ahorita no/i.test(lower);
        if (isNegative) {
          await this.updateState(phone, { state: "prospect_cold" });
          return await respond("Sin problema. Cuando quieras retomar, escr\u00edbeme. El programa sigue abierto.");
        }
        // If they sent what looks like a name (2+ words, no commands) — treat as name directly
        const words = body.trim().split(/\s+/);
        if (words.length >= 2 && body.trim().length >= 5 && !/\d/.test(body) && !matchModelFromText(lower)) {
          // They gave their name directly after seeing the corrida — create folio
          const nombre = body.trim();
          try {
            const folioResult = await createFolioFromWhatsApp(this.storage, phone, nombre, phone);
            await this.updateState(phone, { state: "prospect_docs_capture", context: { ...prospectState.context, nombre, folio: folioResult.folio } as any, folioId: folioResult.originationId });
            try { await upsertProspect({ phone, nombre, status: "registrado", folio_id: folioResult.folio }); }
            catch (e: any) { console.error(`[Pipeline] upsertProspect registrado:`, e.message); }
            const canalCtx = prospectState.context?.canal || "ORGANICO";
            const modelo = prospectState.context?.modelo as any;
            const modeloStr = modelo ? `${modelo.marca} ${modelo.modelo} ${modelo.anio}` : "Por definir";
            const notifMsg = `*Nuevo registro* \u2705\nNombre: ${nombre}\nTel: ${phone}\nCanal: ${canalCtx}\nModelo: ${modeloStr}\nConsumo: ${prospectState.context?.leqMes || "?"} LEQ/mes\nFolio: ${folioResult.folio}`;
            await notifyTeam(notifMsg);
            return await respond(`Listo, ${nombre.split(" ")[0]}. Tu folio es *${folioResult.folio}*.\n\nAhora vamos con tu expediente. M\u00e1ndame tu *INE de frente* \uD83D\uDCF7`);
          } catch (e: any) {
            console.error(`[Folio] createFolioFromWhatsApp FAILED:`, e.message);
            return await respond(`Hubo un problema t\u00e9cnico. Intenta de nuevo en unos minutos.`);
          }
        }
      }

      // ── State: prospect_awaiting_name — solo nombre ──
      if (prospectState.state === "prospect_awaiting_name") {
        const nombre = body.trim();
        if (nombre.length >= 3 && nombre.split(/\s+/).length >= 2) {
          // Create folio + register
          try {
            const folioResult = await createFolioFromWhatsApp(this.storage, phone, nombre, phone);
            await this.updateState(phone, { state: "prospect_docs_capture", context: { ...prospectState.context, nombre, folio: folioResult.folio } as any, folioId: folioResult.originationId });
            try { await upsertProspect({ phone, nombre, status: "registrado", folio_id: folioResult.folio }); }
            catch (e: any) { console.error(`[Pipeline] upsertProspect registrado:`, e.message); }
            
            // Notify team
            const canalCtx = prospectState.context?.canal || "ORGANICO";
            const modelo = prospectState.context?.modelo as any;
            const modeloStr = modelo ? `${modelo.marca} ${modelo.modelo} ${modelo.anio}` : "Por definir";
            const notifMsg = `*Nuevo registro* \u2705\nNombre: ${nombre}\nTel: ${phone}\nCanal: ${canalCtx}\nModelo: ${modeloStr}\nCombustible: ${prospectState.context?.fuelType || "?"}\nConsumo: ${prospectState.context?.leqMes || "?"} LEQ/mes\nFolio: ${folioResult.folio}`;
            await notifyTeam(notifMsg);
            
            return await respond(`Listo, ${nombre.split(" ")[0]}. Tu folio es *${folioResult.folio}*.\n\nAhora vamos con tu expediente. Son 11 documentos que me puedes mandar por foto. Empecemos:\n\nM\u00e1ndame tu *INE de frente* \uD83D\uDCF7`);
          } catch (e: any) {
            console.error(`[Folio] createFolioFromWhatsApp FAILED:`, e.message);
            return await respond(`Hubo un problema t\u00e9cnico al crear tu registro. Intenta de nuevo en unos minutos o escr\u00edbenos al 446 329 3102.`);
          }
        } else {
          return await respond("Necesito tu nombre completo (nombre y apellido). Ejemplo: Juan P\u00e9rez L\u00f3pez");
        }
      }

      // ── State: prospect_docs_capture — el agente guía doc por doc ──
      // (docs are handled by the existing media handler below when the prospect sends photos)
      // Here we handle text messages during doc capture
      if (prospectState.state === "prospect_docs_capture") {
        // Check if they want to skip to interview
        const wantsInterview = /entrevista|preguntas|voz|audio|saltar|skip|despu[eé]s.*doc|no tengo/i.test(lower);
        if (wantsInterview) {
          await this.updateState(phone, { state: "interview_ready", context: prospectState.context });
          return await respond("No te preocupes, los documentos que falten los completamos despu\u00e9s.\n\nVamos con una entrevista r\u00e1pida: son 8 preguntas por nota de voz, toma unos 5 minutos. \u00bfListo?\n\nEscribe *empezar* cuando quieras.");
        }
        // Offer interview if they seem stuck
        const isStuck = /no tengo|no lo tengo|todav[ií]a no|ahorita no|despu[eé]s|ma[nñ]ana|luego/i.test(lower);
        if (isStuck) {
          return await respond("Sin problema, lo mandas cuando lo tengas.\n\nMientras tanto, \u00bfquieres que hagamos una *entrevista r\u00e1pida*? Son 8 preguntas por nota de voz (5 minutos). As\u00ed avanzamos con tu evaluaci\u00f3n.");
        }
        // If they're asking about progress or what's next
        const asksProgress = /cu[aá]nto|falta|siguiente|qu[eé] sigue|progreso|estado/i.test(lower);
        if (asksProgress && prospectState.folioId) {
          const pInfo = await this.getPendingInfo(prospectState.folioId);
          if (pInfo.count > 0) {
            return await respond(`Te faltan *${pInfo.count} documentos*: ${pInfo.text}\n\nM\u00e1ndame el siguiente: *${pInfo.nextKey || "foto del documento"}* \uD83D\uDCF7`);
          } else {
            return await respond("Tu expediente documental est\u00e1 completo. \u00bfHacemos la entrevista r\u00e1pida? Escribe *empezar*.");
          }
        }
      }

      // ── Catch-all: detect registration intent from any state ──
      const wantsToRegister = /quiero registrarme|c[oó]mo me registro|quiero aplicar|quiero entrar|registrarme|inscribirme|me apunto|d[oó]nde me anoto|c[oó]mo le hago para entrar/i.test(lower);
      if (wantsToRegister && !prospectState.state?.startsWith("prospect_awaiting")) {
        await this.updateState(phone, { state: "prospect_awaiting_name", context: prospectState.context || {} });
        return await respond("\u00bfC\u00f3mo te llamas? (nombre completo)");
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
      ctx += ` | Docs: ${(clientState.docsCapturados || []).length}/${clientState.totalDocs || 11}`;
      if ((clientState.docsPendientes || []).length > 0) ctx += ` | Pendientes: ${clientState.docsPendientes.join(", ")}`;
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
    if (mediaUrl && originationId && (role === "cliente" || role === "promotora" || role === "director" || role === "prospecto")) {
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
      
      // Build existingData from origination datos_* columns for cross-check
      if (originationId) {
        try {
          const origForCross = await this.storage.getOrigination(originationId) as any;
          const existingData: Record<string, any> = {};
          const colMap: Record<string, string> = {
            datos_ine: "ine_frente", datos_csf: "csf", datos_comprobante: "comprobante_domicilio",
            datos_concesion: "concesion", datos_estado_cuenta: "estado_cuenta",
            datos_historial: "historial_gnv", datos_factura: "factura_vehiculo",
          };
          for (const [col, key] of Object.entries(colMap)) {
            const raw = origForCross?.[col] || origForCross?.[col.replace('datos_','')];
            if (raw) {
              try { existingData[key] = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {}
            }
          }
          if (Object.keys(existingData).length > 0) {
            (media as any)._existingData = existingData;
          }
        } catch {}
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
        // Update pipeline with doc progress
        const { updateProspectDocs } = await import("./pipeline-ventas");
        updateProspectDocs(phone, capturedList.length, DOC_ORDER.length).catch(() => {});
        
        // === PROMOTORA: Deterministic doc response — accept any order, show folio always ===
        if ((role === "promotora" || role === "director") && docSaved) {
          const docLabel = DOC_LABELS[docSaved] || docSaved;
          const folioStr = (convState.context as any)?.folio?.folio || "";
          const folioTag = folioStr ? ` (${folioStr})` : "";
          const tName = (convState.context as any)?.folio?.taxistaName || "";
          const nameTag = tName ? ` de ${tName}` : "";

          if (pendingList.length === 0) {
            return await respond(`*${docLabel}* recibido ✓\n\nTodos los papeles de${nameTag}${folioTag} están completos (${capturedList.length}/${DOC_ORDER.length}). ¿Hacemos la entrevista ahora?\n\n_entrevista · cambiar folio_`);
          } else {
            // Show next pending doc — but don't block if they send a different one
            const nextDocLabel = DOC_LABELS[pendingList[0]] || pendingList[0];
            const remaining = pendingList.length;
            return await respond(`*${docLabel}* recibido ✓${nameTag}${folioTag}\n\n${capturedList.length}/${DOC_ORDER.length} papeles. Faltan ${remaining}: siguiente es *${nextDocLabel}*. ¿Me lo mandas? (o manda cualquier otro que tengas)\n\n_entrevista · cambiar folio_`);
          }
        }

        // === PROSPECT: Guided doc-by-doc response (deterministic, not LLM) ===
        if (role === "prospecto" && docSaved) {
          const docLabel = DOC_LABELS[docSaved] || docSaved;
          if (pendingList.length === 0) {
            // All docs complete!
            await this.updateState(phone, { state: "interview_ready", context: { ...convState.context, docsComplete: true } });
            try { const { updateProspectStatus: ups } = await import("./pipeline-ventas"); await ups(phone, "docs_completo"); } catch(e:any) { console.error('[Pipeline]', e.message); }
            return await respond(`*${docLabel}* recibido. ${capturedList.length}/${DOC_ORDER.length} documentos.\n\nTu expediente est\u00e1 completo. Ahora vamos con una *entrevista r\u00e1pida* (8 preguntas por nota de voz, ~5 min).\n\nEscribe *empezar* cuando est\u00e9s listo.`);
          } else {
            const nextDoc = DOC_ORDER.find(d => !capturedKeys.has(d.key));
            const nextLabel = nextDoc ? nextDoc.label : "siguiente documento";
            return await respond(`*${docLabel}* recibido. ${capturedList.length}/${DOC_ORDER.length}\n\nAhora m\u00e1ndame tu *${nextLabel}*`);
          }
        }
      }
    } else if (mediaUrl && !originationId) { visionNote = "Imagen sin folio vinculado."; }

    // ===== RAG: Try FAQ/knowledge base first for questions (all roles) =====
    if (body && !mediaUrl && !docSaved) {
      const isQuestion = /\?|qu[eé]|c[oó]mo|cu[aá]ndo|cu[aá]nto|d[oó]nde|por\s*qu[eé]|puedo|necesito|hay|existe|funciona|pasa\s+si/i.test(body);
      if (isQuestion) {
        try {
          const { answerQuestion } = await import("./agent/rag");
          const ragAnswer = await answerQuestion(body);
          if (ragAnswer) {
            return await respond(ragAnswer);
          }
        } catch (e: any) {
          console.error("[RAG] Error in old agent:", e.message);
        }
      }
    }

    // ===== PROMOTORA: deterministic fallback BEFORE LLM =====
    if (role === "promotora" && body && !docSaved && !mediaUrl) {
      const lo = body.toLowerCase().trim();

      // ── MENU NAVIGATION: number shortcut to select folio from greeting list ──
      const numMatch = lo.match(/^(\d)$/);
      if (numMatch && !originationId && convState?.state !== "waiting_folio_name" && convState?.state !== "waiting_folio_phone") {
        const idx = parseInt(numMatch[1]) - 1;
        try {
          const allOrigs = await this.storage.listOriginations();
          const activos = allOrigs
            .filter((o: any) => !["RECHAZADO", "COMPLETADO", "CANCELADO"].includes(o.estado))
            .sort((a: any, b: any) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
            .slice(0, 5);
          if (idx >= 0 && idx < activos.length) {
            const selected = activos[idx] as any;
            originationId = selected.id;
            await this.updateState(phone, { folioId: selected.id, state: "capturing_docs", context: { folio: { id: selected.id, folio: selected.folio, taxistaName: selected.taxistaName } } });
            const pI = await this.getPendingInfo(selected.id);
            const nombre = selected.taxistaName || selected.folio;
            const pendingStr = pI.count > 0 ? `Faltan: *${pI.text}*` : "Documentos completos";
            return await respond(`📋 *${nombre}* — ${selected.folio}\n${pendingStr}\n\n_docs · entrevista · cambiar folio_`);
          }
        } catch (e: any) {
          console.error("[PromoMenu] Error selecting folio:", e.message);
        }
      }

      // ── QUESTION DETECTION: if promotora asks a question while in doc capture, use RAG or status ──
      if (originationId && /\?|est[aá]n\s+correct|datos|verific|checar|revisar|c[oó]mo\s+va|qu[eé]\s+falta|cu[aá]nto|cu[aá]les/i.test(lo)) {
        // "Están correctos los datos?" / "cómo va?" / "qué falta?" → show folio status
        try {
          const pI = await this.getPendingInfo(originationId);
          const tName = (convState?.context as any)?.folio?.taxistaName || "el taxista";
          const folioStr = (convState?.context as any)?.folio?.folio || "";
          const { neon: neonQ } = await import("@neondatabase/serverless");
          const sqlQ = neonQ(process.env.DATABASE_URL!);
          const docRows = await sqlQ`
            SELECT tipo, ocr_result FROM documents
            WHERE origination_id = ${originationId}
            AND (image_data IS NOT NULL OR ocr_result IS NOT NULL)
          ` as any[];
          const capturedList = docRows.map((d: any) => {
            const label = DOC_ORDER.find(o => o.key === d.tipo)?.label || d.tipo;
            return `✅ ${label}`;
          }).join('\n');
          const pendingStr = pI.count > 0 ? `\n\nFaltan *${pI.count}*: ${pI.text}` : '\n\n✅ Documentos completos';
          return await respond(`📋 *${tName}* — ${folioStr}\n\n${capturedList || 'Sin documentos aún'}${pendingStr}\n\n_Mándame foto del siguiente doc, o escribe *entrevista* / *cambiar folio*_`);
        } catch (e: any) {
          console.error('[PromoQuestion]', e.message);
        }
      }

      // ── FOLIO ACTIVE COMMANDS: docs / entrevista / cambiar folio ──
      if (originationId) {
        if (/^docs?$|^documentos?$|^papeles?$/i.test(lo)) {
          const pI = await this.getPendingInfo(originationId);
          const pendingStr = pI.count > 0 ? `Faltan: *${pI.text}*\n\nMándame el siguiente documento.` : "Todos los documentos están capturados. ✅";
          return await respond(pendingStr + `\n\n_entrevista · cambiar folio_`);
        }
        if (/^entrevista$|^iniciar\s+entrevista$|^hacer\s+entrevista$/i.test(lo)) {
          // Set interview mode — fall through to existing interview handler
          // (just let it fall through, the interview trigger is handled below)
        }
        if (/^cambiar\s+folio$|^otro\s+folio$|^cambiar$|^menu$|^menú$/i.test(lo)) {
          await this.updateState(phone, { state: "idle", folio_id: null, context: {} });
          originationId = null;
          try {
            const allOrigs = await this.storage.listOriginations();
            const activos = allOrigs
              .filter((o: any) => !["RECHAZADO", "COMPLETADO", "CANCELADO"].includes(o.estado))
              .sort((a: any, b: any) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
              .slice(0, 5);
            let msg = "¿Con quién trabajamos?";
            if (activos.length > 0) {
              msg += "\n";
              activos.forEach((o: any, i: number) => {
                msg += `\n${i + 1}. ${o.taxistaName || o.folio}`;
              });
              msg += "\n\n*Nuevo prospecto:* escribe nombre y teléfono";
            }
            return await respond(msg);
          } catch (e: any) {
            return await respond("¿Con quién trabajamos? Escribe el nombre o número de folio.");
          }
        }
      }

      // Intent: new person / new prospect (natural language variants)
      // Bug fix: detect negation BEFORE checking new prospect intent
      const hasNegation = /^no\b|\bno\s+quiero|\bno\s+nuevo|\bno\s+registr|\bno\s+meter/i.test(lo);
      const wantsNewProspect = !hasNegation && /tengo\s+(un|una|a\s+un|a\s+una)|(^|\s)(nuevo|nueva)(\s|$)|\bregistrar\b|\bmeter\b|\bagregar\b|\balta\b|interesado|viene\s+uno|hay\s+un|hay\s+una|se\s+quiere/i.test(lo);
      if (wantsNewProspect && !convState?.state?.includes("waiting")) {
        await this.updateState(phone, { state: "waiting_folio_name", folio_id: null, context: {} });
        originationId = null;
        return await respond("¿Cómo se llama?");
      }

      // Ángeles pide que se envíe el reporte PDF por email
      const wantsEmailReport = /env[ií]a?(?:le)?\s+el\s+reporte|manda\s+el\s+reporte|reporte\s+por\s+(?:correo|email|mail)|env[ií]a?(?:lo)?\s+al\s+correo|mandar\s+(?:el\s+)?reporte/i.test(lo);
      if (wantsEmailReport) {
        try {
          const r = await fetch("https://cmu-originacion.fly.dev/api/originacion/reporte-pdf", { method: "POST" });
          const d = await r.json() as any;
          if (d.success) {
            return await respond(`Listo. Envié el reporte a mireles.ageles60@gmail.com\n\n${d.stats.total} trámites | ${d.stats.sinAvance} sin avance | ${d.stats.completos} listos para firma.`);
          } else {
            return await respond(`No pude enviar el reporte: ${d.message || "error desconocido"}. Avísale a Josué.`);
          }
        } catch (e: any) {
          return await respond(`Error al generar el reporte: ${e.message}`);
        }
      }

      // ===== PROMOTOR MENU RESPONSES =====
      // Option 1: Dudas del programa
      if (lo === "1" || /^dudas?$/i.test(lo)) {
        return await respond(`*Temas frecuentes:*\n\n\u2022 *requisitos* \u2014 15 documentos + vigencias\n\u2022 *proceso* \u2014 paso a paso del tr\u00e1mite\n\u2022 *kit* \u2014 kit GNV incluido\n\u2022 *enganche* \u2014 anticipo y d\u00eda 56\n\u2022 *cuota* \u2014 c\u00f3mo funciona la amortizaci\u00f3n\n\u2022 *fondo de garant\u00eda* \u2014 FG y mora\n\u2022 *gas* \u2014 estaciones, ahorro, bicombustible\n\u2022 *seguro* \u2014 responsabilidad del taxista\n\u2022 *firma* \u2014 contrato digital o presencial\n\nEscribe cualquier tema o pregunta directa.`);
      }

      // Option 2: Nuevo prospecto
      if (lo === "2" || /^nuevo$/i.test(lo)) {
        await this.updateState(phone, { state: "waiting_folio_name" as any, folio_id: null, context: {} });
        return await respond("Nombre del taxista y tel\u00e9fono:\nEjemplo: *Pedro L\u00f3pez 4491234567*");
      }

      // Auditar expediente: run cross-validation on a folio
      if (/^(?:auditar|validar|verificar|check)\s*(?:expediente)?/i.test(lo) || lo === "auditar") {
        try {
          const { neon: neonAudit } = await import("@neondatabase/serverless");
          const sqlA = neonAudit(process.env.DATABASE_URL!);
          // Get the most recent active folio
          const folios = await sqlA`
            SELECT o.id, o.folio, o.estado,
              CONCAT(t.nombre, ' ', t.apellido_paterno, ' ', COALESCE(t.apellido_materno, '')) as nombre,
              o.extracted_data
            FROM originations o
            LEFT JOIN taxistas t ON t.id = o.taxista_id
            WHERE o.estado NOT IN ('RECHAZADO','CANCELADO')
              AND (t.telefono IS NULL OR t.telefono NOT LIKE '521999%')
            ORDER BY o.updated_at DESC LIMIT 5
          ` as any[];
          if (folios.length === 0) return await respond("No hay expedientes activos para auditar.");
          // If multiple, list them
          if (folios.length > 1) {
            const list = folios.map((f: any, i: number) => `${i+1}. *${f.folio}* \u2014 ${f.nombre || '?'} (${f.estado})`).join('\n');
            return await respond(`\u00bfCu\u00e1l expediente auditar?\n\n${list}\n\nEscribe *auditar [folio]*`);
          }
          const folio = folios[0];
          const allDocs = folio.extracted_data || {};
          const { auditExpediente } = await import("./agent/post-ocr-validation");
          const audit = auditExpediente(allDocs);
          return await respond(`${audit.summary}\n\n_Folio: ${folio.folio} \u2014 ${folio.nombre}_`);
        } catch (e: any) {
          return await respond(`Error al auditar: ${e.message}`);
        }
      }

      // Option 3: Buscar prospecto (promotora) / Evaluar (director)
      if (lo === "3" || /^(?:buscar|evaluar)$/i.test(lo) || /buscar\s+prospecto/i.test(lo)) {
        if (role === "promotora") {
          return await respond(`Escribe el *nombre* o *folio* del prospecto.\n\nEjemplo:\n• *Pedro López*\n• *CMU-SIN-260417-001*`);
        }
        // Director: eval instructions
        return await respond(`Para evaluar, escribe el modelo con precio y reparación:\n\n*march 120k rep 10k*\n*aveo 100k 0 rep*\n*vento 2020 150k rep 5k*\n\nTambién puedes pedir precios de mercado:\n*mercado march 2021*`);
      }

      // ── BUSCAR PROSPECTO: match by name or folio (promotora) ──
      if (role === "promotora" && !originationId && body.length >= 3 && body.length <= 60 && !/^\d{1,2}$/.test(lo)
        && !/^(?:dudas|nuevo|inventario|evaluar|buscar|auditar|docs|entrevista|hola|menu|menú|cambiar|reporte|pendientes)$/i.test(lo)
        && !wantsNewProspect && !wantsEmailReport
        && convState?.state !== "waiting_folio_name" && convState?.state !== "waiting_folio_phone"
        && !lo.startsWith("mercado") && !/\d+k/.test(lo)
      ) {
        try {
          const { neon: neonSearch } = await import("@neondatabase/serverless");
          const sqlS = neonSearch(process.env.DATABASE_URL!);
          const isFolio = /^cmu-/i.test(lo);
          let results: any[];
          if (isFolio) {
            results = await sqlS`
              SELECT o.id, o.folio, o.estado,
                CONCAT(t.nombre, ' ', COALESCE(t.apellido_paterno,'')) as nombre_completo,
                COUNT(d.id) FILTER (WHERE d.image_data IS NOT NULL) as docs_count
              FROM originations o
              LEFT JOIN taxistas t ON t.id = o.taxista_id
              LEFT JOIN documents d ON d.origination_id = o.id
              WHERE UPPER(o.folio) = UPPER(${body.trim()})
              GROUP BY o.id, o.folio, o.estado, t.nombre, t.apellido_paterno
            ` as any[];
          } else {
            const searchTerm = `%${body.trim()}%`;
            results = await sqlS`
              SELECT o.id, o.folio, o.estado,
                CONCAT(t.nombre, ' ', COALESCE(t.apellido_paterno,'')) as nombre_completo,
                COUNT(d.id) FILTER (WHERE d.image_data IS NOT NULL) as docs_count
              FROM originations o
              LEFT JOIN taxistas t ON t.id = o.taxista_id
              LEFT JOIN documents d ON d.origination_id = o.id
              WHERE o.estado NOT IN ('RECHAZADO','CANCELADO')
                AND (t.telefono IS NULL OR t.telefono NOT LIKE '521999%')
                AND (CONCAT(t.nombre, ' ', COALESCE(t.apellido_paterno,''), ' ', COALESCE(t.apellido_materno,'')) ILIKE ${searchTerm}
                  OR o.folio ILIKE ${searchTerm})
              GROUP BY o.id, o.folio, o.estado, t.nombre, t.apellido_paterno
              ORDER BY o.updated_at DESC LIMIT 5
            ` as any[];
          }
          if (results.length === 1) {
            const r = results[0];
            await this.updateState(phone, { folioId: r.id, state: "capturing_docs", context: { folio: { id: r.id, folio: r.folio, taxistaName: r.nombre_completo } } });
            originationId = r.id;
            const pI = await this.getPendingInfo(r.id);
            return await respond(`\ud83d\udccb *${r.nombre_completo?.trim() || r.folio}* \u2014 ${r.folio}\nEstado: ${r.estado} | Docs: ${r.docs_count}/15\n${pI.count > 0 ? `Faltan: *${pI.text}*` : '\u2705 Documentos completos'}\n\n_Mándame foto del siguiente doc, o escribe *entrevista* / *cambiar folio*_`);
          } else if (results.length > 1) {
            const list = results.map((r: any, i: number) => `${i+1}. *${r.nombre_completo?.trim() || '?'}* \u2014 ${r.folio} (${r.docs_count}/15 docs)`).join('\n');
            return await respond(`Encontré ${results.length} resultados:\n\n${list}\n\nEscribe el *folio* para seleccionar.`);
          }
          // No results — don't intercept, let it fall through to LLM
        } catch (e: any) {
          console.error('[PromoSearch] Error:', e.message);
        }
      }

      // Option 4: Ver inventario
      if (lo === "4" || /(?:inventario|veh[i\u00ed]culos?\s+(?:disponibles?|tenemos)|carros?\s+(?:disponibles?|tenemos)|qu[e\u00e9]\s+(?:hay|tienen))/i.test(lo)) {
        try {
          const { neon: neonInv } = await import("@neondatabase/serverless");
          const sqlI = neonInv(process.env.DATABASE_URL!);
          const inv = await sqlI`
            SELECT brand, model, variant, year, cmu AS cmu_valor, status
            FROM vehicles_inventory
            WHERE status = 'disponible'
            ORDER BY brand, model, year
          ` as any[];

          if (inv.length === 0) return await respond("No hay veh\u00edculos disponibles en este momento.");

          const lines: string[] = [`\ud83d\ude97 *Inventario CMU* (${inv.length} disponibles):`, ``];
          for (const v of inv) {
            const name = `${v.brand} ${v.model}${v.variant ? " " + v.variant : ""} ${v.year}`;
            lines.push(`\u2022 *${name}* \u2014 $${Number(v.cmu_valor).toLocaleString()}`);
          }
          lines.push(``, `Dime el modelo y te calculo la cuota con tu consumo de combustible.`);
          return await respond(lines.join("\n"));
        } catch (e: any) {
          console.error("[Inventario]", e.message);
        }
      }

      // Reportes determinísticos — construidos desde Neon, sin LLM
      const wantsReport = /pendientes?|sin\s+avance|reporte|cu[aá]ntos?\s+(faltan|tienen|llevan)|listado|todos\s+los\s+tr|todos\s+los\s+fol/i.test(lo);
      if (wantsReport) {
        try {
          // Single optimized query — join originations + document counts in one shot
          const { neon } = await import("@neondatabase/serverless");
          const sql = neon(process.env.DATABASE_URL!);
          const rows = await sql`
            SELECT
              o.id, o.folio, o.estado, o.updated_at, o.created_at,
              CONCAT(t.nombre, CASE WHEN t.apellido_paterno IS NOT NULL THEN ' ' || t.apellido_paterno ELSE '' END, CASE WHEN t.apellido_materno IS NOT NULL THEN ' ' || t.apellido_materno ELSE '' END) as taxista_nombre,
              COUNT(d.id) FILTER (WHERE d.image_data IS NOT NULL OR d.ocr_result IS NOT NULL) as docs_count,
              EXISTS(SELECT 1 FROM evaluaciones_taxi e WHERE e.folio_id = o.folio) as entrevista_ok
            FROM originations o
            LEFT JOIN taxistas t ON t.id = o.taxista_id
            LEFT JOIN documents d ON d.origination_id = o.id
            WHERE o.estado NOT IN ('RECHAZADO', 'COMPLETADO', 'CANCELADO')
              AND (t.telefono IS NULL OR t.telefono NOT LIKE '521999%')
            GROUP BY o.id, o.folio, o.estado, o.updated_at, o.created_at, t.nombre, t.apellido_paterno, t.apellido_materno
            ORDER BY o.updated_at ASC
          ` as any[];

          if (rows.length === 0) return await respond("No hay trámites activos por ahora.");

          const TOTAL = 14;
          const lines: string[] = [];
          for (const r of rows) {
            const name2 = r.taxista_nombre || r.folio;
            const days = Math.floor((Date.now() - new Date(r.updated_at || r.created_at).getTime()) / (1000*60*60*24));
            const daysStr = days > 0 ? ` (${days}d)` : "";
            const docsCount = parseInt(r.docs_count) || 0;
            const faltanCount = TOTAL - docsCount;
            if (faltanCount > 0) {
              lines.push(`• *${name2}*${daysStr}: ${docsCount}/${TOTAL} papeles`);
            } else if (!r.entrevista_ok) {
              lines.push(`• *${name2}*${daysStr}: papeles completos, falta entrevista`);
            } else {
              lines.push(`• *${name2}*${daysStr}: completo ✓`);
            }
          }
          return await respond(`*${rows.length} trámites activos:*\n\n${lines.join("\n")}`);
        } catch (e: any) {
          console.error("[Reporte]", e.message);
          // fall through to LLM
        }
      }

      // "días sin avance" filter
      const diasMatch = lo.match(/m[aá]s\s+de\s+(\d+)\s+d[ií]as/);
      if (diasMatch) {
        const dias = parseInt(diasMatch[1]);
        try {
          const origs = await this.storage.listOriginations();
          const stale2 = origs.filter((o: any) => {
            if (["RECHAZADO", "COMPLETADO"].includes((o as any).estado)) return false;
            const d = Math.floor((Date.now() - new Date((o as any).updatedAt || (o as any).createdAt).getTime()) / (1000*60*60*24));
            return d > dias;
          });
          if (stale2.length === 0) return await respond(`Ningún trámite lleva más de ${dias} días sin avance.`);
          const lines2 = stale2.map((o: any) => {
            const d = Math.floor((Date.now() - new Date(o.updatedAt || o.createdAt).getTime()) / (1000*60*60*24));
            return `• *${o.taxistaName || o.folio}* — ${d} días`;
          });
          return await respond(`*${stale2.length} trámites sin avance (más de ${dias} días):*\n\n${lines2.join("\n")}`);
        } catch (e: any) { /* fall through */ }
      }

      // "continuar con documentos" / "seguir con papeles" post-entrevista
      const wantsContinueDocs = /continuar\s+(con\s+)?(los\s+)?(documentos?|papeles?)|seguir\s+(con\s+)?(los\s+)?(documentos?|papeles?)|volver\s+a\s+(documentos?|papeles?)/i.test(lo);
      if (wantsContinueDocs && originationId) {
        // Query real doc count from DB
        const { neon: neon2 } = await import("@neondatabase/serverless");
        const sql2 = neon2(process.env.DATABASE_URL!);
        const docRows = await sql2`
          SELECT tipo FROM documents
          WHERE origination_id = ${originationId}
          AND (image_data IS NOT NULL OR ocr_result IS NOT NULL)
        ` as any[];
        const capturedKeys2 = new Set(docRows.map((d: any) => d.tipo));
        const pendingDocs = DOC_ORDER.filter(d => !capturedKeys2.has(d.key));
        const tName = (convState?.context as any)?.folio?.taxistaName || "el taxista";
        const folioStr2 = (convState?.context as any)?.folio?.folio || "";
        if (pendingDocs.length === 0) {
          return await respond(`Los papeles de ${tName} están completos (${DOC_ORDER.length}/${DOC_ORDER.length}). La entrevista ya quedó hecha. El expediente está listo para revisión.`);
        }
        const nextLabel = pendingDocs[0].label;
        return await respond(`De ${tName}${folioStr2 ? ` (${folioStr2})` : ""} tenemos ${capturedKeys2.size}/${DOC_ORDER.length} papeles.\n\nSiguiente: *${nextLabel}*. Mándame la foto cuando la tengas.`);
      }

      // No folio context + vague action keyword → ask who
      const isVagueAction = /entrevista|documento|foto|imagen|papeles?|status|estado|siguiente|falta|sigue/i.test(lo);
      if (isVagueAction && !originationId) {
        return await respond("¿De quién? Dime el nombre del taxista.");
      }

      // With folio context + vague message → let LLM handle with good context
      // (fall through to LLM with enriched prompt)
    }

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

    // Phase 2: Use modular prompt system
    const sys = buildSystemPrompt(role === "prospecto" ? "prospect" : role, {
      knowledgeBase: knowledgeAB,
      fuelContext: fuel.text,
      canal: canalLabel,
      profile,
      pending: pInfo.text,
      simulation: simulationData ? `\n=== SIMULACION ===\n${simulationData}` : undefined,
      stateContext: stateCtx + carteraCtx,
      docOrder: DOC_ORDER.map((d, i) => `${i + 1}. ${d.label}`).join(" | ")
    });
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
