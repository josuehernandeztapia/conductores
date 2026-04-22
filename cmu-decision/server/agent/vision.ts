/**
 * CMU WhatsApp Agent v3 — Vision (Document Classification + Validation)
 *
 * Uses GPT-4V to:
 * 1. Classify document type from image
 * 2. Validate legibility and quality
 * 3. Extract structured data (nombre, CURP, etc.)
 * 4. Cross-reference against existing data (INE = source of truth)
 */


import type { DocDefinition, VisionResult } from "./types";
import { chatCompletion } from "./openai-helper";
import { logOcrCall } from "../ocr-provenance";

// ─── Document Order (15 documents) ──────────────────────────────────────────

export const DOC_ORDER: DocDefinition[] = [
  {
    key: "ine_frente",
    label: "INE Frente (credencial para votar — lado de la foto)",
    visualId: "Escudo nacional arriba, texto 'INSTITUTO NACIONAL ELECTORAL', texto 'CREDENCIAL PARA VOTAR', fotografía del titular, firma del titular",
    extract: "nombre, apellido_paterno, apellido_materno, curp (18 caracteres), clave_elector (18 caracteres), domicilio, fecha_nacimiento, seccion, vigencia (formato año-año), sexo, estado, municipio",
    crossCheck: "ES FUENTE DE VERDAD para nombre completo. VIGENCIA INE: formato es AÑO_INICIO-AÑO_FIN (ej: 2025-2035 significa válida HASTA 2035). Compara AÑO_FIN con la fecha actual — solo es vencida si AÑO_FIN < año actual. Si vigencia vencida → flag 'ine_vencida'. Si vence este año o el siguiente → flag 'ine_proxima_vencer'. El nombre extraído aquí se usará para validar TODOS los demás documentos.",
  },
  {
    key: "ine_reverso",
    label: "INE Reverso (lado sin foto)",
    visualId: "Código MRZ (3 líneas de caracteres alfanuméricos), código QR, logo 'INE'. NO tiene foto del titular. NO tiene domicilio (eso está al frente).",
    extract: "numero_ine (extraer de la línea MRZ que empieza con 'IDMEX'), cic (número CIC impreso), curp_mrz (CURP embebido en la línea MRZ)",
    crossCheck: "El CURP extraído del MRZ (curp_mrz) DEBE coincidir exactamente con el CURP del INE frente. Si no coincide → flag 'curp_mismatch'.",
  },
  {
    key: "tarjeta_circulacion",
    label: "Tarjeta de Circulación",
    visualId: "Texto 'TARJETA DE CIRCULACIÓN', logo del gobierno estatal, datos del vehículo, placa",
    extract: "propietario (nombre completo), rfc, placa, marca, linea (modelo/línea), anio (año/modelo), niv (número de serie, 17 caracteres), tipo_servicio (leer EXACTAMENTE: particular/público/taxi/servicio público), combustible, color",
    crossCheck: "PRIMERO verifica nombre: el campo 'propietario' DEBE coincidir con el nombre completo de la INE frente. Si NO coincide → flag 'nombre_mismatch' SIEMPRE. SEGUNDO verifica tipo: Si tipo_servicio NO es 'público', 'taxi' ni 'servicio público' (si es 'particular', 'escolar', 'carga', etc.) → flag 'no_es_taxi'. IMPORTANTE: ambos checks son INDEPENDIENTES — verifica el nombre AUNQUE ya hayas encontrado no_es_taxi.",
  },
  {
    key: "factura_vehiculo",
    label: "Factura del Vehículo (CFDI)",
    visualId: "Texto 'CFDI', UUID fiscal, texto 'FACTURA', sello digital SAT, cadena original",
    extract: "emisor_nombre (agencia/vendedor), receptor_nombre (comprador), receptor_rfc, marca, modelo, anio, niv (17 caracteres), monto (valor total)",
    crossCheck: "El campo 'receptor_nombre' DEBE coincidir con el nombre de la INE frente. Si no → flag 'nombre_mismatch'. El NIV DEBE coincidir con el NIV de la tarjeta de circulación. Si no → flag 'niv_mismatch'.",
  },
  {
    key: "csf",
    label: "Constancia de Situación Fiscal (CSF del SAT)",
    visualId: "Texto 'SERVICIO DE ADMINISTRACIÓN TRIBUTARIA', 'CÉDULA DE IDENTIFICACIÓN FISCAL', 'CONSTANCIA DE SITUACIÓN FISCAL'",
    extract: "rfc, curp, nombre (nombre completo), domicilio_fiscal, regimen (régimen fiscal), fecha_emision",
    crossCheck: "PRIMERO verifica nombre: el campo 'nombre' (o nombre completo = nombre(s) + primer_apellido + segundo_apellido) DEBE coincidir con el nombre completo de la INE frente. Si NO coincide → flag 'nombre_mismatch' SIEMPRE, independientemente de otros flags. SEGUNDO verifica CURP: DEBE coincidir con el CURP de la INE frente. Si no → flag 'curp_mismatch'. TERCERO verifica fecha: la fecha_emision debe ser de los últimos 30 días desde hoy. Si es más antigua → flag 'csf_vencida'. CUARTO verifica RFC: para persona física debe tener exactamente 13 caracteres (4 letras + 6 dígitos fecha + 3 homonimia). Si tiene menos de 12 o más de 13 caracteres → flag 'rfc_invalido'. IMPORTANTE: todos estos checks son INDEPENDIENTES — un flag NO bloquea a los demás.",
  },
  {
    key: "comprobante_domicilio",
    label: "Comprobante de Domicilio",
    visualId: "Logo de CFE, JMAS, Telmex, o banco; datos del servicio, dirección, periodo de facturación",
    extract: "titular (nombre del titular del servicio), direccion (dirección completa: calle, número, colonia, municipio, CP), fecha_periodo (fecha o periodo de facturación), tipo_servicio (CFE/agua/teléfono/banco)",
    crossCheck: "REGLA ESPECIAL NOMBRE: El 'titular' NO necesita coincidir con la INE — puede ser esposa, familiar u otra persona. NO marques 'nombre_mismatch' para comprobante de domicilio.\nREGLA CRÍTICA DOMICILIO: La 'direccion' (calle, colonia, municipio) DEBE coincidir con el 'domicilio' extraído de la INE frente. Compara calle+número+colonia+municipio. Si la dirección NO coincide → flag 'domicilio_mismatch'.\nLa fecha_periodo debe ser de los últimos 3 meses. Si es más antigua → flag 'domicilio_vencido'.",
  },
  {
    key: "concesion",
    label: "Concesión de Taxi",
    visualId: "Texto 'CONCESIÓN', escudo del gobierno estatal, datos de la concesión, número de concesión",
    extract: "numero_concesion, titular (nombre completo del concesionario), vigencia, municipio, tipo_servicio (leer EXACTAMENTE lo que dice el documento: TAXI / colectivo / urbano / suburbano / mixto), modalidad",
    crossCheck: "El campo 'titular' DEBE coincidir con el nombre de la INE. Si no → flag 'nombre_mismatch'. La concesión debe estar vigente. Si vencida → flag 'expired'. El municipio debe ser Aguascalientes. Si es otro → flag 'municipio_no_ags'.\nREGLA CRÍTICA TIPO: El tipo_servicio DEBE ser 'TAXI' (o incluir 'taxi'). Si dice 'colectivo', 'urbano', 'suburbano', 'mixto' u otro tipo que NO sea taxi → flag 'tipo_no_taxi'. Esto es un RECHAZO — solo aceptamos concesiones de TAXI.",
  },
  {
    key: "estado_cuenta",
    label: "Estado de Cuenta Bancario (carátula)",
    visualId: "Logo del banco, texto 'ESTADO DE CUENTA', datos bancarios, CLABE, dirección del cuentahabiente",
    extract: "titular (nombre del titular de la cuenta), banco (nombre del banco), clabe (CLABE interbancaria, 18 dígitos), numero_cuenta, direccion (dirección del cuentahabiente si aparece en la carátula)",
    crossCheck: "El campo 'titular' DEBE coincidir con el nombre de la INE frente. Si no → flag 'nombre_mismatch'. La CLABE debe tener exactamente 18 dígitos numéricos. Si tiene más o menos → flag 'clabe_invalid'.\nCROSS-CHECK DOMICILIO: Si el estado de cuenta muestra dirección, DEBE coincidir con el domicilio de la INE frente (calle, colonia, municipio). Si no coincide → flag 'domicilio_mismatch'.",
  },
  {
    key: "historial_gnv",
    label: "Tickets/Historial GNV",
    visualId: "Ticket de papel (recibo térmico) con encabezado 'NATGAS' o 'gas natural vehicular', 'GAS NATURAL VEHICULAR COMPRIMIDO', datos de estación de servicio, No. de Ticket 'AGP...', litros cargados, precio por litro ($11/LEQ aprox), nombre del operador, placa del vehículo. NO es una credencial, NO tiene foto de persona.",
    extract: "placa (placa del vehículo que cargó, ej: FXK1001105), litros (cantidad en litros/LEQ cargados, ej: 7.8 o 144.02), precio_leq (precio por litro en pesos, ej: 11.04), monto (total en pesos, ej: 86.11 o 1589.97), fecha (fecha de la carga, formato YYYY-MM-DD), no_ticket (número de ticket, ej: AGP260048896), estacion (nombre de la estación, ej: EDS Aguascalientes Poniente), operador (nombre del operador que atendió)",
    crossCheck: "La placa extraida DEBE coincidir con la placa de la tarjeta de circulación si ya está capturada. Si no coincide → flag 'placa_mismatch_gnv'. El promedio mensual de LEQ (litros * 26 días) debe ser >= 300. Si es menor → flag 'consumo_bajo_gnv'.",
  },
  {
    key: "tickets_gasolina",
    label: "Tickets Gasolina (Perfil B)",
    visualId: "Ticket/voucher de estación de gasolina, litros, monto en pesos",
    extract: "litros, monto (pesos), fecha, estacion (nombre de la estación)",
    crossCheck: "El monto mensual acumulado (promedio ticket × 26 días laborales) debe ser >= $9,600 MXN. Si es menor → flag 'gasto_bajo_gasolina'. Regla de producto: se requiere un mínimo de 10 tickets del último mes para inferir consumo (muestreo operativo en PWA puede requerir menos).",
  },
  {
    key: "carta_membresia",
    label: "Carta Gremial o de Ingreso",
    visualId: "Papel membretado de agrupación/organización de taxistas (ACATAXI, CTM, etc.), puede ser carta de membresía O carta de ingreso. Buscar: logo/membrete, sello, firma del líder",
    extract: "tipo_carta ('membresia' o 'ingreso'), agrupacion (nombre: ACATAXI, CTM, etc.), nombre_concesionario, concesion (número), numero_economico, placa, ingreso_mensual (si es carta de ingreso), fecha, tiene_sello (true/false), tiene_membrete (true/false), tiene_firma (true/false)",
    crossCheck: "El campo 'nombre_concesionario' DEBE coincidir con el nombre de la INE frente. Si no → flag 'nombre_mismatch'. Si es carta de ingreso: verificar que tenga sello, membrete y firma. Si falta alguno → flag 'carta_incompleta'. Cualquiera de las dos (membresía o ingreso) es válida.",
  },
  {
    key: "selfie_biometrico",
    label: "Selfie con INE",
    visualId: "Fotografía tipo selfie: rostro de una persona visible junto a una credencial INE que se ve legible",
    extract: "rostro_visible (true/false: ¿se ve claramente el rostro?), ine_legible (true/false: ¿la INE junto al rostro es legible?)",
    crossCheck: "El rostro en la selfie debe coincidir visualmente con la foto de la INE frente. Si no parece la misma persona → flag 'rostro_no_coincide'.",
  },
  {
    key: "ine_operador",
    label: "INE del Operador (persona diferente al titular)",
    visualId: "Escudo nacional, texto 'INSTITUTO NACIONAL ELECTORAL', 'CREDENCIAL PARA VOTAR', foto de una persona DIFERENTE al titular principal",
    extract: "nombre, apellido_paterno, apellido_materno, curp (18 caracteres), clave_elector (18 caracteres), domicilio, fecha_nacimiento, seccion, vigencia (año-año), sexo, estado, municipio",
    crossCheck: "DEBE ser una persona DIFERENTE al titular de la INE frente principal. Si el nombre es igual → flag 'misma_persona_que_titular'. La vigencia NO debe estar vencida. Si vencida → flag 'ine_operador_vencida'.",
  },
  {
    key: "licencia_conducir",
    label: "Licencia de Conducir",
    visualId: "Texto 'LICENCIA DE CONDUCIR', fotografía, categoría/tipo, vigencia, estado emisor",
    extract: "nombre (nombre completo), tipo_licencia (categoría/tipo), vigencia, estado (estado emisor)",
    crossCheck: "La licencia debe estar vigente. Si vencida → flag 'licencia_vencida'. El nombre debe coincidir con la INE del operador (si existe) o con la INE del titular principal. Si no → flag 'nombre_mismatch'.",
  },
  {
    key: "fotos_unidad",
    label: "Fotos de la Unidad (frente, trasera, lateral izq, lateral der)",
    visualId: "Foto de un vehículo tipo taxi, puede ser toma frontal, trasera, lateral izquierda o lateral derecha",
    extract: "placa_visible (true/false: ¿se ve la placa?), placa (número de placa si es legible), angulo (frente/trasera/lateral_izq/lateral_der), estado_general (descripción breve del estado visual del vehículo), color",
    crossCheck: "Si la placa es visible y legible, DEBE coincidir con la placa de la tarjeta de circulación. Si no coincide → flag 'placa_mismatch'.",
  },
];

export const DOC_KEYS: string[] = DOC_ORDER.map(d => d.key);
export const DOC_LABELS: Record<string, string> = Object.fromEntries(
  DOC_ORDER.map(d => [d.key, d.label])
);
export const TOTAL_DOCS = DOC_ORDER.length;

// ─── Build GPT-4V prompt ────────────────────────────────────────────────────

export function buildVisionPrompt(
  expectedType: string,
  docOrder: DocDefinition[],
  existingData: Record<string, any>,
): string {
  const expectedDoc = docOrder.find(d => d.key === expectedType);
  const allDocTypes = docOrder.map(d => `${d.key}: "${d.label}" — visual: ${d.visualId}`).join("\n");

  // Build a human-readable summary of existing data for cross-checks
  const existingEntries: string[] = [];
  if (Object.keys(existingData).length > 0) {
    for (const [docKey, data] of Object.entries(existingData)) {
      if (data && typeof data === "object") {
        const docDef = docOrder.find(d => d.key === docKey);
        const label = docDef?.label || docKey;
        const fields = Object.entries(data)
          .filter(([_, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => `    ${k}: "${v}"`)
          .join("\n");
        if (fields) {
          existingEntries.push(`  [${label}]:\n${fields}`);
        }
      }
    }
  }
  const existingDataBlock = existingEntries.length > 0
    ? `\n══════════════════════════════════════════════════\nDATOS YA EXTRAÍDOS DE DOCUMENTOS ANTERIORES (usa estos valores para cross-check):\n${existingEntries.join("\n")}\n══════════════════════════════════════════════════`
    : "\n(No hay datos previos todavía — este es el primer documento.)";

  // Build per-field extraction instructions
  const extractFields = expectedDoc?.extract || "N/A";
  const fieldList = extractFields.split(",").map(f => f.trim());
  const fieldInstructions = fieldList
    .map(f => `  - "${f.split("(")[0].trim()}": extrae el valor exacto. Si no es legible o no existe, pon null.`)
    .join("\n");

  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  return `Eres un verificador experto de documentos mexicanos para un programa de renovación de taxis en Aguascalientes, México.
Fecha actual: ${today}

════════════════════════════════════════════════════
TAREA: Analiza esta imagen y realiza 4 pasos:
  1. CLASIFICAR — ¿Qué tipo de documento es?
  2. VALIDAR LEGIBILIDAD — ¿Se leen todos los campos? ¿4 bordes visibles? ¿No está borrosa/cortada/oscura?
  3. EXTRAER TODOS LOS CAMPOS — Cada campo listado abajo. Si un campo no es legible → null (NUNCA omitas un campo).
  4. CROSS-CHECK — Compara los datos extraídos contra los documentos anteriores.
════════════════════════════════════════════════════

── PASO 1: CLASIFICACIÓN ──
DOCUMENTO ESPERADO: "${expectedDoc?.label || expectedType}" (key: ${expectedType})
Indicadores visuales ESPERADOS en esta imagen:
  ${expectedDoc?.visualId || "N/A"}

⚠️ REGLA DE CLASIFICACIÓN PRIORITARIA:
- Si ves un TICKET DE PAPEL TÉRMICO con la palabra NATGAS, gas natural, LEQ, litros cargados → es 'historial_gnv' SIN IMPORTAR qué esperabas.
- Si ves una CREDENCIAL con FOTO DE PERSONA, nombre, CURP → es 'ine_frente' o 'ine_reverso'.
- Si ves una LICENCIA DE CONDUCIR con foto → es 'licencia'.
- NUNCA confundas un ticket de papel (recibo) con una credencial de identidad. Son completamente diferentes.
- PRIORIZA lo que VES en la imagen sobre lo que se esperaba.

Todos los tipos de documentos válidos:
${allDocTypes}

── PASO 2: LEGIBILIDAD ──
- ¿Se ven los 4 bordes del documento?
- ¿La imagen es nítida y sin reflejos que oculten texto?
- ¿Todos los campos clave son legibles?
- Si CUALQUIER campo importante es completamente ilegible → is_legible: false + rejection_reason.

── PASO 3: EXTRACCIÓN DE CAMPOS ──
Si el documento coincide con "${expectedDoc?.label || expectedType}", extrae TODOS estos campos:
${fieldInstructions}

Descripción completa de campos:
${extractFields}

REGLAS DE EXTRACCIÓN:
- Extrae CADA campo listado arriba. No omitas ninguno.
- Si un campo no es legible o no aparece en el documento, pon null como valor.
- Respeta el formato indicado (ej: CURP = 18 caracteres, CLABE = 18 dígitos, NIV = 17 caracteres).
- Para nombres, extrae tal cual aparecen en el documento (mayúsculas/minúsculas como estén).
- Para fechas, usa formato YYYY-MM-DD cuando sea posible.

REGLA CRÍTICA DE EXTRACCIÓN:
- Debes extraer MÍNIMO 5 campos para INE frente (nombre, curp, domicilio, vigencia, fecha_nacimiento).
- Si la imagen es legible, NUNCA devuelvas solo 1-2 campos. Examina cada campo listado.
- Si un campo no es legible, pon null. Pero INTENTA leer cada uno.
- Las imágenes pueden estar rotadas 90° — ajusta tu lectura.

── PASO 4: CROSS-CHECK ──
Reglas específicas para "${expectedDoc?.label || expectedType}":
${expectedDoc?.crossCheck || "N/A"}

Reglas generales de cross-check:
⚠️ REGLA CRÍTICA DE EXHAUSTIVIDAD: Debes ejecutar TODOS los checks siempre. Encontrar un flag NO te exime de buscar los demás. El array cross_check_flags debe contener TODOS los problemas encontrados, no solo el primero.
- La INE frente es FUENTE DE VERDAD para nombre completo Y domicilio.
- Si el nombre en este documento ≠ nombre de INE frente → flag "nombre_mismatch" (EXCEPCIÓN: comprobante_domicilio puede tener nombre diferente)
- COMPARACIÓN DE NOMBRES: ignora acentos y mayúsculas/minúsculas. "ELVIRA FLORES ORTIZ" ≠ "TORRES ORTIZ DIOSCORO" → nombre_mismatch. "CAPETILLO ZAMORA HECTOR" ≠ "TORRES ORTIZ DIOSCORO" → nombre_mismatch.
- Si CURP en este documento ≠ CURP de INE → flag "curp_mismatch"
- Si vigencia/fecha está vencida → flag "expired"
- Si CLABE no tiene exactamente 18 dígitos → flag "clabe_invalid"
- Si comprobante domicilio tiene fecha > 3 meses → flag "domicilio_vencido"
- Si CSF tiene fecha_emision > 30 días → flag "csf_vencida"

██ REGLAS CRÍTICAS DE RECHAZO (estos flags causan RECHAZO del documento):
- Si tarjeta circulación tipo_servicio no es taxi/público → flag "no_es_taxi" (RECHAZO)
- Si concesión tipo_servicio no es TAXI (es colectivo/urbano/suburbano) → flag "tipo_no_taxi" (RECHAZO)
- Si concesión municipio ≠ Aguascalientes → flag "municipio_no_ags" (RECHAZO)

██ CROSS-CHECK DE DOMICILIO (crítico):
- El domicilio/dirección debe ser CONSISTENTE entre: INE frente, comprobante de domicilio, y estado de cuenta (carátula).
- Compara: calle + número + colonia + municipio. Pequeñas variaciones de escritura son OK (ej: "Col." vs "Colonia", abreviaciones).
- Si la dirección NO coincide → flag "domicilio_mismatch"

- Si NIV no coincide con tarjeta circulación → flag "niv_mismatch"
- Si placa no coincide con tarjeta circulación → flag "placa_mismatch"
${existingDataBlock}

════════════════════════════════════════════════════
FORMATO DE RESPUESTA — Solo JSON válido, nada más:
{
  "detected_type": "key del tipo detectado (de la lista arriba) o 'unknown'",
  "matches_expected": true | false,
  "is_legible": true | false,
  "extracted_data": {
    "campo1": "valor1",
    "campo2": "valor2",
    "campo3": null
  },
  "cross_check_flags": ["flag1", "flag2"],
  "confidence": 0.0 a 1.0,
  "rejection_reason": "razón si is_legible=false, o null si todo ok"
}

REGLAS FINALES:
- Si la imagen NO es un documento → detected_type: "unknown", is_legible: false, rejection_reason: "La imagen no es un documento."
- Si está borrosa/cortada/oscura al punto de no poder leer campos clave → is_legible: false, rejection_reason explica el problema.
- Si es un documento válido pero DIFERENTE al esperado → detected_type con el key correcto, matches_expected: false.
- extracted_data DEBE contener TODOS los campos listados arriba (con null para los no legibles). No omitas campos.
- cross_check_flags es un array vacío [] si no hay problemas.
- Solo responde con el JSON. Sin texto adicional antes o después.`;
}

// ─── Main API ────────────────────────────────────────────────────────────────

/**
 * Classify and validate a document image using GPT-4V.
 *
 * @param imageBase64 - Base64-encoded image (JPEG or PNG)
 * @param expectedType - The document type we're expecting (key from DOC_ORDER)
 * @param docOrder - The document definitions (default: DOC_ORDER)
 * @param existingData - Data extracted from previous docs (for cross-reference)
 * @returns VisionResult with classification, validation, and extracted data
 */
export interface OcrContext {
  phone?: string | null;
  originationId?: number | null;
}

export async function classifyAndValidateDoc(
  imageBase64: string,
  expectedType: string,
  docOrder: DocDefinition[] = DOC_ORDER,
  existingData: Record<string, any> = {},
  context: OcrContext = {},
): Promise<VisionResult> {

  const prompt = buildVisionPrompt(expectedType, docOrder, existingData);
  const provenanceBase = {
    phone: context.phone || null,
    originationId: context.originationId || null,
    documentType: expectedType,
    provider: "openai" as const,
    providerModel: "gpt-4o",
  };

  try {
    const response = await chatCompletion(
      [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: "high" } },
          ],
        },
      ],
      { model: "gpt-4o", max_tokens: 2500, temperature: 0 },
    );

    const text = (typeof response === 'string' ? response : '').trim();

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);

      // Validate and normalize the response
      const validDocKeys = docOrder.map(d => d.key);
      const detectedType = validDocKeys.includes(parsed.detected_type)
        ? parsed.detected_type
        : "unknown";

      // AVP v3 Cláusula V bis inciso c): registro de trazabilidad interna.
      logOcrCall({ ...provenanceBase, status: "success" }).catch(() => { /* non-blocking */ });

      return {
        detected_type: detectedType,
        matches_expected: detectedType === expectedType,
        is_legible: parsed.is_legible === true,
        extracted_data: parsed.extracted_data || {},
        cross_check_flags: Array.isArray(parsed.cross_check_flags) ? parsed.cross_check_flags : [],
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        rejection_reason: parsed.rejection_reason || undefined,
      };
    }

    console.error("[Vision] Could not parse GPT-4V response as JSON:", text.slice(0, 200));
    logOcrCall({
      ...provenanceBase,
      status: "error",
      errorMessage: "Non-JSON response",
    }).catch(() => { /* non-blocking */ });
    return makeErrorResult("No se pudo analizar la imagen. Intenta de nuevo.");
  } catch (error: any) {
    console.error("[Vision] GPT-4V call failed:", error.message);
    logOcrCall({
      ...provenanceBase,
      status: "error",
      errorMessage: error.message || "unknown error",
    }).catch(() => { /* non-blocking */ });
    return makeErrorResult("Error procesando la imagen. Intenta de nuevo.");
  }
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeErrorResult(reason: string): VisionResult {
  return {
    detected_type: "unknown",
    matches_expected: false,
    is_legible: false,
    extracted_data: {},
    cross_check_flags: [],
    confidence: 0,
    rejection_reason: reason,
  };
}

/**
 * Get the next expected document given already-collected doc keys.
 */
export function getNextExpectedDoc(
  collectedKeys: string[],
  docOrder: DocDefinition[] = DOC_ORDER,
): DocDefinition | null {
  for (const doc of docOrder) {
    if (!collectedKeys.includes(doc.key)) {
      return doc;
    }
  }
  return null; // all collected
}

/**
 * Find a doc definition by its key.
 */
export function getDocByKey(key: string): DocDefinition | undefined {
  return DOC_ORDER.find(d => d.key === key);
}

/**
 * Get pending documents labels.
 */
export function getPendingDocLabels(collectedKeys: string[]): string[] {
  return DOC_ORDER
    .filter(d => !collectedKeys.includes(d.key))
    .map(d => d.label);
}
