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

// ─── Document Order (14 documents) ──────────────────────────────────────────

export const DOC_ORDER: DocDefinition[] = [
  {
    key: "ine_frente",
    label: "INE Frente",
    visualId: "escudo nacional, CREDENCIAL PARA VOTAR, foto persona, INSTITUTO NACIONAL ELECTORAL",
    extract: "nombre_completo, apellido_paterno, apellido_materno, domicilio, clave_elector, seccion, fecha_nacimiento, sexo, vigencia, municipio, estado",
    crossCheck: "FUENTE DE VERDAD. ¿Vigente? ¿4 bordes visibles? Nombre vs dato verbal.",
  },
  {
    key: "ine_reverso",
    label: "INE Reverso",
    visualId: "códigos MRZ, QR, logo INE",
    extract: "curp, numero_ine, fecha_expiracion_mrz",
    crossCheck: "CURP vs frente. Expiración.",
  },
  {
    key: "tarjeta_circulacion",
    label: "Tarjeta de Circulación",
    visualId: "TARJETA DE CIRCULACIÓN, NIV, placas",
    extract: "propietario, rfc, marca, modelo, anio, niv, placas, uso, combustible",
    crossCheck: "Propietario=INE? uso≠TAXI→alertar.",
  },
  {
    key: "factura_vehiculo",
    label: "Factura del Vehículo",
    visualId: "CFDI, UUID, factura",
    extract: "marca, modelo, anio, niv, propietario, valor",
    crossCheck: "NIV=tarjeta? Propietario=INE?",
  },
  {
    key: "csf",
    label: "Constancia Situación Fiscal",
    visualId: "SAT, CÉDULA DE IDENTIFICACIÓN FISCAL",
    extract: "rfc, curp, nombre, domicilio_fiscal, regimen",
    crossCheck: "Nombre=INE. CURP=INE. Fecha<30días.",
  },
  {
    key: "comprobante_domicilio",
    label: "Comprobante Domicilio",
    visualId: "CFE, JMAS, Telmex, recibo",
    extract: "titular, direccion, fecha",
    crossCheck: "Fecha<3meses. Titular=INE?",
  },
  {
    key: "concesion",
    label: "Concesión de Taxi",
    visualId: "CONCESIÓN, gobierno estatal",
    extract: "numero_concesion, titular, vigencia, municipio",
    crossCheck: "Titular=INE? Vigente? Ags?",
  },
  {
    key: "estado_cuenta",
    label: "Estado de Cuenta",
    visualId: "logo bancario, CLABE",
    extract: "titular, banco, clabe",
    crossCheck: "CLABE 18 dígitos. Titular=INE.",
  },
  {
    key: "historial_gnv",
    label: "Tickets GNV",
    visualId: "voucher GNV, litros, NATGAS",
    extract: "litros, fecha, estacion, promedio_leq",
    crossCheck: "≥400LEQ?",
  },
  {
    key: "carta_membresia",
    label: "Carta Membresía",
    visualId: "agrupación gremial, taxi",
    extract: "agrupacion, nombre, vigencia",
    crossCheck: "Nombre=INE.",
  },
  {
    key: "selfie_biometrico",
    label: "Selfie con INE",
    visualId: "rostro + INE visible",
    extract: "rostro_visible, ine_visible",
    crossCheck: "Coincide con foto INE?",
  },
  {
    key: "ine_operador",
    label: "INE del Operador",
    visualId: "CREDENCIAL PARA VOTAR, foto persona diferente al titular",
    extract: "nombre_completo, curp, vigencia",
    crossCheck: "Persona diferente al titular. Vigente?",
  },
  {
    key: "licencia_conducir",
    label: "Licencia de Conducir",
    visualId: "LICENCIA DE CONDUCIR, foto, categoría, vigencia",
    extract: "nombre, numero_licencia, categoria, vigencia, estado",
    crossCheck: "Nombre=INE titular o INE operador? Vigente? Categoría permite transporte?",
  },
  {
    key: "fotos_unidad",
    label: "Fotos Unidad Actual",
    visualId: "foto de vehículo taxi, frente/trasera/laterales",
    extract: "angulo, estado_visual, color, placas_visibles",
    crossCheck: "Placas=tarjeta circulación?",
  },
];

export const DOC_LABELS: Record<string, string> = {};
DOC_ORDER.forEach(d => { DOC_LABELS[d.key] = d.label; });

// ─── Build GPT-4V prompt ────────────────────────────────────────────────────

function buildVisionPrompt(
  expectedType: string,
  docOrder: DocDefinition[],
  existingData: Record<string, any>,
): string {
  const expectedDoc = docOrder.find(d => d.key === expectedType);
  const allDocTypes = docOrder.map(d => `${d.key}: "${d.label}" — visual: ${d.visualId}`).join("\n");

  const existingDataSummary = Object.keys(existingData).length > 0
    ? `\nDatos ya extraídos de documentos anteriores (para cross-check):\n${JSON.stringify(existingData, null, 2)}`
    : "";

  return `Eres un verificador de documentos para un programa de renovación de taxis en México.

TAREA: Analiza esta imagen de documento.

DOCUMENTO ESPERADO: "${expectedDoc?.label || expectedType}" (key: ${expectedType})
Indicadores visuales esperados: ${expectedDoc?.visualId || "N/A"}

TODOS LOS TIPOS DE DOCUMENTOS VÁLIDOS:
${allDocTypes}

CAMPOS A EXTRAER si coincide con "${expectedDoc?.label || expectedType}":
${expectedDoc?.extract || "N/A"}

REGLAS DE CROSS-CHECK:
${expectedDoc?.crossCheck || "N/A"}
${existingDataSummary}

RESPONDE SOLO con JSON válido:
{
  "detected_type": "key del tipo detectado o 'unknown'",
  "matches_expected": true/false,
  "is_legible": true/false,
  "extracted_data": { campo: "valor", ... },
  "cross_check_flags": ["flag1", ...],
  "confidence": 0.0-1.0,
  "rejection_reason": "razón si no es legible o no es documento válido, null si ok"
}

Reglas:
- Si la imagen no es un documento → detected_type: "unknown", is_legible: false
- Si está borrosa/cortada/oscura → is_legible: false, rejection_reason explica
- Si es un documento válido pero diferente al esperado → detected_type correcto, matches_expected: false
- INE es FUENTE DE VERDAD: si nombre en otro doc ≠ nombre INE → flag "nombre_mismatch"
- Vigencia vencida → flag "expired"
- Cross-check CURP: si CURP extraído ≠ CURP de INE reverso → flag "curp_mismatch"
- CLABE debe tener 18 dígitos → flag "clabe_invalid" si no
- Comprobante domicilio >3 meses → flag "domicilio_vencido"
- CSF >30 días → flag "csf_vencida"
- Solo responde JSON, nada más.`;
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
export async function classifyAndValidateDoc(
  imageBase64: string,
  expectedType: string,
  docOrder: DocDefinition[] = DOC_ORDER,
  existingData: Record<string, any> = {},
): Promise<VisionResult> {

  const prompt = buildVisionPrompt(expectedType, docOrder, existingData);

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
      { model: "gpt-4o", max_tokens: 800, temperature: 0 },
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
    return makeErrorResult("No se pudo analizar la imagen. Intenta de nuevo.");
  } catch (error: any) {
    console.error("[Vision] GPT-4V call failed:", error.message);
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
