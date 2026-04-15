/**
 * POST-OCR VALIDATION — Algorithmic cross-checks after GPT-4o Vision
 * 
 * The LLM does cross-checks via prompt instructions, but it can miss things.
 * This module provides server-side verification as a safety net.
 * 
 * Runs AFTER vision returns, BEFORE response is sent to user.
 * Adds flags to visionResult.cross_check_flags[] if issues found.
 */

// ===== HELPER: Normalize name for comparison =====
function normalizeName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // remove accents
    .replace(/[^A-Z\s]/g, '')  // keep only letters and spaces
    .replace(/\s+/g, ' ')
    .trim();
}

function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return true; // can't compare if either is missing
  // Check if one contains the other (handles "JOSE PEREZ" vs "JOSE LUIS PEREZ GARCIA")
  const tokensA = na.split(' ').filter(t => t.length > 2);
  const tokensB = nb.split(' ').filter(t => t.length > 2);
  // At least 2 tokens must match
  const matches = tokensA.filter(t => tokensB.includes(t));
  return matches.length >= 2;
}

// ===== HELPER: CURP validation (RENAPO format) =====
function validateCURP(curp: string | null | undefined): { valid: boolean; reason?: string } {
  if (!curp) return { valid: true }; // can't validate if missing
  const clean = curp.toUpperCase().replace(/\s/g, '');
  if (clean.length !== 18) return { valid: false, reason: `${clean.length} chars (debe ser 18)` };
  // Format: 4 letters + 6 digits (YYMMDD) + 1 letter (sexo) + 2 letters (estado) + 3 consonantes + 1 homoclave + 1 dígito
  const pattern = /^[A-Z]{4}\d{6}[HM][A-Z]{2}[A-Z]{3}[A-Z0-9]\d$/;
  if (!pattern.test(clean)) return { valid: false, reason: 'formato inválido' };
  // Verify date portion (positions 4-9: YYMMDD)
  const mm = parseInt(clean.slice(6, 8));
  const dd = parseInt(clean.slice(8, 10));
  if (mm < 1 || mm > 12) return { valid: false, reason: `mes ${mm} inválido` };
  if (dd < 1 || dd > 31) return { valid: false, reason: `día ${dd} inválido` };
  return { valid: true };
}

// ===== HELPER: RFC validation =====
function validateRFC(rfc: string | null | undefined): { valid: boolean; reason?: string } {
  if (!rfc) return { valid: true };
  const clean = rfc.toUpperCase().replace(/\s/g, '');
  // Persona física: 4 letters + 6 digits + 3 homoclave = 13
  // Persona moral: 3 letters + 6 digits + 3 homoclave = 12
  if (clean.length < 12 || clean.length > 13) return { valid: false, reason: `${clean.length} chars (debe ser 12-13)` };
  const patternPF = /^[A-Z]{4}\d{6}[A-Z0-9]{3}$/; // persona física
  const patternPM = /^[A-Z]{3}\d{6}[A-Z0-9]{3}$/; // persona moral
  if (!patternPF.test(clean) && !patternPM.test(clean)) return { valid: false, reason: 'formato inválido' };
  return { valid: true };
}

// ===== HELPER: NIV/VIN validation (ISO 3779) =====
function validateNIV(niv: string | null | undefined): { valid: boolean; reason?: string } {
  if (!niv) return { valid: true };
  const clean = niv.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, ''); // exclude I, O, Q
  if (clean.length !== 17) return { valid: false, reason: `${clean.length} chars (debe ser 17)` };
  // Check digit (position 9) — ISO 3779
  const transliteration: Record<string, number> = {
    A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9,
    '0':0,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,
  };
  const weights = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const val = transliteration[clean[i]];
    if (val === undefined) return { valid: false, reason: `caracter inválido: ${clean[i]}` };
    sum += val * weights[i];
  }
  const remainder = sum % 11;
  const expectedCheck = remainder === 10 ? 'X' : String(remainder);
  if (clean[8] !== expectedCheck) {
    return { valid: false, reason: `dígito verificador: esperado ${expectedCheck}, tiene ${clean[8]}` };
  }
  return { valid: true };
}

// ===== HELPER: Date validation =====
function isDateExpired(dateStr: string | null | undefined): boolean {
  if (!dateStr) return false;
  try {
    const d = new Date(dateStr);
    return d.getTime() < Date.now();
  } catch { return false; }
}

function isOlderThanMonths(dateStr: string | null | undefined, months: number): boolean {
  if (!dateStr) return false;
  try {
    const d = new Date(dateStr);
    const limit = new Date();
    limit.setMonth(limit.getMonth() - months);
    return d.getTime() < limit.getTime();
  } catch { return false; }
}

// ===== MAIN: Post-OCR cross-validation =====
export interface PostOCRResult {
  addedFlags: string[];
  log: string[];
}

export function postOCRValidation(
  detectedType: string,
  extractedData: Record<string, any>,
  existingData: Record<string, any>,
  currentFlags: string[],
): PostOCRResult {
  const addedFlags: string[] = [];
  const log: string[] = [];

  function addFlag(flag: string) {
    if (!currentFlags.includes(flag) && !addedFlags.includes(flag)) {
      addedFlags.push(flag);
    }
  }

  // Get INE frente data as source of truth
  const ine = existingData.ine_frente || existingData.datos_ine || {};
  const ineNombre = ine.nombre || ine.nombre_completo || 
    [ine.nombre, ine.apellido_paterno, ine.apellido_materno].filter(Boolean).join(' ') || '';
  const ineCURP = ine.curp || '';
  const ineDomicilio = ine.domicilio || '';
  const ineVigencia = ine.vigencia || '';

  // Get tarjeta circulación data
  const tarjeta = existingData.tarjeta_circulacion || existingData.datos_concesion || {};
  const tarjetaPlaca = tarjeta.placa || '';
  const tarjetaNIV = tarjeta.niv || '';

  // ─── PER-DOCUMENT VALIDATIONS ───

  if (detectedType === 'ine_frente') {
    // CURP format
    const curpResult = validateCURP(extractedData.curp);
    if (!curpResult.valid) {
      addFlag('curp_formato_invalido');
      log.push(`[CURP] Formato inválido: ${curpResult.reason}`);
    }
    // Vigencia check
    if (ineVigencia || extractedData.vigencia) {
      const vig = extractedData.vigencia || ineVigencia;
      // INE vigencia format is typically "2025" or "2025-2035" — check year
      const yearMatch = String(vig).match(/(\d{4})/);
      if (yearMatch) {
        const vigYear = parseInt(yearMatch[1]);
        if (vigYear < new Date().getFullYear()) {
          addFlag('ine_vencida');
          log.push(`[INE] Vigencia vencida: ${vig}`);
        }
      }
    }
  }

  if (detectedType === 'ine_reverso') {
    // CURP from MRZ vs INE frente
    if (extractedData.curp_mrz && ineCURP) {
      const mrz = extractedData.curp_mrz.toUpperCase().trim();
      const front = ineCURP.toUpperCase().trim();
      if (mrz !== front && mrz.length >= 16 && front.length >= 16) {
        addFlag('curp_mismatch');
        log.push(`[INE reverso] CURP MRZ "${mrz}" ≠ INE frente "${front}"`);
      }
    }
  }

  if (detectedType === 'tarjeta_circulacion') {
    // Nombre vs INE
    if (extractedData.propietario && ineNombre) {
      if (!namesMatch(extractedData.propietario, ineNombre)) {
        addFlag('nombre_mismatch');
        log.push(`[Tarjeta] Nombre "${normalizeName(extractedData.propietario)}" ≠ INE "${normalizeName(ineNombre)}"`);
      }
    }
    // NIV format
    const nivResult = validateNIV(extractedData.niv);
    if (!nivResult.valid) {
      addFlag('niv_formato_invalido');
      log.push(`[Tarjeta] NIV inválido: ${nivResult.reason}`);
    }
    // Tipo servicio must be taxi/público
    if (extractedData.tipo_servicio) {
      const tipo = extractedData.tipo_servicio.toLowerCase();
      if (!tipo.includes('taxi') && !tipo.includes('público') && !tipo.includes('publico') && !tipo.includes('servicio público')) {
        addFlag('no_es_taxi');
        log.push(`[Tarjeta] Tipo servicio: "${extractedData.tipo_servicio}" (no es taxi)`);
      }
    }
  }

  if (detectedType === 'factura_vehiculo') {
    // Nombre vs INE
    if (extractedData.receptor_nombre && ineNombre) {
      if (!namesMatch(extractedData.receptor_nombre, ineNombre)) {
        addFlag('nombre_mismatch');
        log.push(`[Factura] Receptor "${normalizeName(extractedData.receptor_nombre)}" ≠ INE "${normalizeName(ineNombre)}"`);
      }
    }
    // NIV vs tarjeta circulación
    if (extractedData.niv && tarjetaNIV) {
      const facNIV = extractedData.niv.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
      const tarNIV = tarjetaNIV.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
      if (facNIV.length >= 10 && tarNIV.length >= 10 && facNIV !== tarNIV) {
        addFlag('niv_mismatch');
        log.push(`[Factura] NIV "${facNIV}" ≠ Tarjeta "${tarNIV}"`);
      }
    }
    // NIV format check
    const nivResult = validateNIV(extractedData.niv);
    if (!nivResult.valid) {
      log.push(`[Factura] NIV formato: ${nivResult.reason}`);
    }
  }

  if (detectedType === 'csf') {
    // Nombre vs INE
    const csfNombre = extractedData.nombre || 
      [extractedData.nombre, extractedData.primer_apellido, extractedData.segundo_apellido].filter(Boolean).join(' ');
    if (csfNombre && ineNombre) {
      if (!namesMatch(csfNombre, ineNombre)) {
        addFlag('nombre_mismatch');
        log.push(`[CSF] Nombre "${normalizeName(csfNombre)}" ≠ INE "${normalizeName(ineNombre)}"`);
      }
    }
    // CURP vs INE
    if (extractedData.curp && ineCURP) {
      const csfCurp = extractedData.curp.toUpperCase().trim();
      const ineCurp = ineCURP.toUpperCase().trim();
      if (csfCurp !== ineCurp && csfCurp.length >= 16 && ineCurp.length >= 16) {
        addFlag('curp_mismatch');
        log.push(`[CSF] CURP "${csfCurp}" ≠ INE "${ineCurp}"`);
      }
    }
    // CURP format
    const curpResult = validateCURP(extractedData.curp);
    if (!curpResult.valid) {
      addFlag('curp_formato_invalido');
      log.push(`[CSF] CURP formato: ${curpResult.reason}`);
    }
    // RFC format
    const rfcResult = validateRFC(extractedData.rfc);
    if (!rfcResult.valid) {
      addFlag('rfc_invalido');
      log.push(`[CSF] RFC formato: ${rfcResult.reason}`);
    }
    // Fecha emisión < 3 meses
    if (extractedData.fecha_emision) {
      if (isOlderThanMonths(extractedData.fecha_emision, 3)) {
        addFlag('csf_vencida');
        log.push(`[CSF] Fecha emisión > 3 meses: ${extractedData.fecha_emision}`);
      }
    }
  }

  if (detectedType === 'comprobante_domicilio') {
    // NO check nombre (puede ser otro familiar)
    // Vigencia: max 3 meses
    if (extractedData.fecha_periodo) {
      if (isOlderThanMonths(extractedData.fecha_periodo, 3)) {
        addFlag('domicilio_vencido');
        log.push(`[Domicilio] Fecha > 3 meses: ${extractedData.fecha_periodo}`);
      }
    }
  }

  if (detectedType === 'concesion') {
    // Nombre vs INE
    if (extractedData.titular && ineNombre) {
      if (!namesMatch(extractedData.titular, ineNombre)) {
        addFlag('nombre_mismatch');
        log.push(`[Concesión] Titular "${normalizeName(extractedData.titular)}" ≠ INE "${normalizeName(ineNombre)}"`);
      }
    }
    // Tipo servicio = TAXI
    if (extractedData.tipo_servicio) {
      const tipo = extractedData.tipo_servicio.toLowerCase();
      if (!tipo.includes('taxi')) {
        addFlag('tipo_no_taxi');
        log.push(`[Concesión] Tipo: "${extractedData.tipo_servicio}" (no es taxi)`);
      }
    }
    // Municipio = Aguascalientes
    if (extractedData.municipio) {
      const mun = extractedData.municipio.toLowerCase();
      if (!mun.includes('aguascalientes') && !mun.includes('ags')) {
        addFlag('municipio_no_ags');
        log.push(`[Concesión] Municipio: "${extractedData.municipio}" (no es AGS)`);
      }
    }
  }

  if (detectedType === 'estado_cuenta') {
    // Nombre vs INE
    if (extractedData.titular && ineNombre) {
      if (!namesMatch(extractedData.titular, ineNombre)) {
        addFlag('nombre_mismatch');
        log.push(`[Edo. cuenta] Titular "${normalizeName(extractedData.titular)}" ≠ INE "${normalizeName(ineNombre)}"`);
      }
    }
    // CLABE validation already done in orchestrator.ts (Banxico algorithm)
  }

  if (detectedType === 'carta_membresia') {
    // Nombre vs INE
    if (extractedData.nombre_miembro && ineNombre) {
      if (!namesMatch(extractedData.nombre_miembro, ineNombre)) {
        addFlag('nombre_mismatch');
        log.push(`[Membresía] Nombre "${normalizeName(extractedData.nombre_miembro)}" ≠ INE "${normalizeName(ineNombre)}"`);
      }
    }
  }

  if (detectedType === 'historial_gnv' || detectedType === 'tickets_gasolina') {
    // Placa vs tarjeta circulación
    if (extractedData.placa && tarjetaPlaca) {
      const ticketPlaca = extractedData.placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const tarPlaca = tarjetaPlaca.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (ticketPlaca.length >= 5 && tarPlaca.length >= 5 && ticketPlaca !== tarPlaca) {
        addFlag('placa_mismatch');
        log.push(`[Ticket] Placa "${ticketPlaca}" ≠ Tarjeta "${tarPlaca}"`);
      }
    }
  }

  if (detectedType === 'fotos_unidad') {
    // Placa vs tarjeta circulación
    if (extractedData.placa && tarjetaPlaca) {
      const fotoPlaca = extractedData.placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const tarPlaca = tarjetaPlaca.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (fotoPlaca.length >= 5 && tarPlaca.length >= 5 && fotoPlaca !== tarPlaca) {
        addFlag('placa_mismatch');
        log.push(`[Foto unidad] Placa "${fotoPlaca}" ≠ Tarjeta "${tarPlaca}"`);
      }
    }
  }

  if (addedFlags.length > 0) {
    console.log(`[PostOCR] ${detectedType}: added ${addedFlags.length} flags: ${addedFlags.join(', ')}`);
    log.forEach(l => console.log(`  ${l}`));
  }

  return { addedFlags, log };
}
