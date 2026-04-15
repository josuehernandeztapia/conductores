/**
 * NAME MATCHER — Suite de 67 tests de regresión
 * 
 * Valida el name matcher de post-ocr-validation.ts que compara nombres
 * extraídos por OCR contra la INE (fuente de verdad).
 * 
 * Cubre:
 * - Normalización (acentos, mayúsculas)
 * - Abreviaciones mexicanas (HDZ→HERNANDEZ, MA→MARIA, etc.)
 * - Partículas compuestas (DE LA, DEL, DE LOS, SAN, SANTA)
 * - Formato bancario (apellidos primero)
 * - Nombres cortos con solo abreviaciones
 * - Negativos (personas diferentes, compuestos distintos)
 * 
 * Ejecutar:
 *   npx tsx test/name-matcher.ts
 *   curl -X POST https://cmu-originacion.fly.dev/api/test/name-matcher
 */

import {
  _namesMatch as namesMatch,
  _expandAbbreviation as expandAbbreviation,
  _normalizeName as normalizeName,
  _joinParticles as joinParticles,
} from "../server/agent/post-ocr-validation";

export function runNameMatcherTests() {
    function testMatch(id: string, description: string, a: string, b: string, expected: boolean) {
    const result = namesMatch(a, b);
    const pass = result === expected;
    const entry: TestResult = { id, description, pass, a, b, expected, got: result };
    if (!pass) {
      const rawA = normalizeName(a).split(" ").filter(t => t.length > 0).map(expandAbbreviation);
      const rawB = normalizeName(b).split(" ").filter(t => t.length > 0).map(expandAbbreviation);
      entry.tokensA = joinParticles(rawA);
      entry.tokensB = joinParticles(rawB);
    }
    results.push(entry);
  }

  function testJoin(id: string, description: string, input: string[], expected: string[]) {
    const result = joinParticles(input);
    const pass = JSON.stringify(result) === JSON.stringify(expected);
    results.push({ id, description, pass, expected, got: result });
  }

// ═══════════════════════════════════════════════════════════════
// TEST RUNNER
// ═══════════════════════════════════════════════════════════════

interface TestResult {
  id: string;
  description: string;
  pass: boolean;
  a?: string;
  b?: string;
  expected?: any;
  got?: any;
  tokensA?: string[];
  tokensB?: string[];
}

const results: TestResult[] = [];

function testMatch(id: string, description: string, a: string, b: string, expected: boolean) {
  const result = namesMatch(a, b);
  const pass = result === expected;
  const entry: TestResult = { id, description, pass, a, b, expected, got: result };
  if (!pass) {
    const rawA = normalizeName(a).split(" ").filter(t => t.length > 0).map(expandAbbreviation);
    const rawB = normalizeName(b).split(" ").filter(t => t.length > 0).map(expandAbbreviation);
    entry.tokensA = joinParticles(rawA);
    entry.tokensB = joinParticles(rawB);
  }
  results.push(entry);
}

function testJoin(id: string, description: string, input: string[], expected: string[]) {
  const result = joinParticles(input);
  const pass = JSON.stringify(result) === JSON.stringify(expected);
  results.push({ id, description, pass, expected, got: result });
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1: joinParticles() — 11 tests
// Verifica que las partículas se agrupen correctamente
// ═══════════════════════════════════════════════════════════════

testJoin("JP01", "DE LA CRUZ se agrupa como un solo token",
  ["MARIA", "DE", "LA", "CRUZ"], ["MARIA", "DE LA CRUZ"]);

testJoin("JP02", "DEL CASTILLO se agrupa",
  ["JOSE", "DEL", "CASTILLO"], ["JOSE", "DEL CASTILLO"]);

testJoin("JP03", "DE LOS SANTOS triple partícula",
  ["ANA", "DE", "LOS", "SANTOS"], ["ANA", "DE LOS SANTOS"]);

testJoin("JP04", "Partícula seguida de nombre normal no lo absorbe",
  ["PEDRO", "DE", "LA", "ROSA", "MARTINEZ"], ["PEDRO", "DE LA ROSA", "MARTINEZ"]);

testJoin("JP05", "Y como conector entre apellidos",
  ["GARCIA", "Y", "LOPEZ"], ["GARCIA", "Y LOPEZ"]);

testJoin("JP06", "Múltiples compuestos en un solo nombre",
  ["MARIA", "DE", "LA", "CRUZ", "DEL", "VALLE"], ["MARIA", "DE LA CRUZ", "DEL VALLE"]);

testJoin("JP07", "SAN como partícula (SAN JUAN)",
  ["PEDRO", "SAN", "JUAN"], ["PEDRO", "SAN JUAN"]);

testJoin("JP08", "SANTA como partícula (SANTA CRUZ)",
  ["MARIA", "SANTA", "CRUZ", "LOPEZ"], ["MARIA", "SANTA CRUZ", "LOPEZ"]);

testJoin("JP09", "Sin partículas: tokens sin cambio",
  ["PEDRO", "LOPEZ", "GARCIA"], ["PEDRO", "LOPEZ", "GARCIA"]);

testJoin("JP10", "Partícula al final (trailing DE): no se agrupa",
  ["PEDRO", "LOPEZ", "DE"], ["PEDRO", "LOPEZ", "DE"]);

testJoin("JP11", "Dos compuestos consecutivos (DE LA + DE LOS)",
  ["JOSE", "DE", "LA", "TORRE", "DE", "LOS", "REYES"], ["JOSE", "DE LA TORRE", "DE LOS REYES"]);

// ═══════════════════════════════════════════════════════════════
// SECTION 2: Exact / basic matching — 5 tests
// ═══════════════════════════════════════════════════════════════

testMatch("BM01", "Match exacto idéntico",
  "PEDRO LOPEZ GARCIA", "PEDRO LOPEZ GARCIA", true);

testMatch("BM02", "Case insensitive + acentos",
  "Pedro López García", "PEDRO LOPEZ GARCIA", true);

testMatch("BM03", "Acentos en nombre (JOSÉ vs JOSE)",
  "JOSÉ FERNANDO CASTILLO", "JOSE FERNANDO CASTILLO", true);

testMatch("BM04", "Orden invertido (formato bancario: apellidos primero)",
  "HERNANDEZ DE LA CRUZ MA GUADALUPE", "MARIA GUADALUPE HERNANDEZ DE LA CRUZ", true);

testMatch("BM05", "Nombre extra ignorado (3 de 4 tokens match)",
  "JOSE LUIS PEREZ GARCIA", "JOSE PEREZ GARCIA", true);

// ═══════════════════════════════════════════════════════════════
// SECTION 3: Abreviaciones mexicanas — 13 tests
// Diccionario: HDZ, GZZ, MTZ, RDZ, GRRO, FDZ, LPZ, RMZ,
//              MA, GPE, FCO, y variantes
// ═══════════════════════════════════════════════════════════════

testMatch("AB01", "MA. → MARIA",
  "MA. GUADALUPE HERNANDEZ", "MARIA GUADALUPE HERNANDEZ", true);

testMatch("AB02", "HDZ. → HERNANDEZ",
  "MA. GUADALUPE HDZ. DE LA CRUZ", "MARIA GUADALUPE HERNANDEZ DE LA CRUZ", true);

testMatch("AB03", "GZZ → GONZALEZ",
  "JUAN CARLOS GZZ. PEREZ", "JUAN CARLOS GONZALEZ PEREZ", true);

testMatch("AB04", "MTZ → MARTINEZ",
  "ANA MTZ. LOPEZ", "ANA MARTINEZ LOPEZ", true);

testMatch("AB05", "RDZ → RODRIGUEZ",
  "PEDRO RDZ. SANCHEZ", "PEDRO RODRIGUEZ SANCHEZ", true);

testMatch("AB06", "GRRO → GUERRERO",
  "LUIS GRRO. MORA", "LUIS GUERRERO MORA", true);

testMatch("AB07", "FDZ → FERNANDEZ",
  "CARLOS FDZ. RUIZ", "CARLOS FERNANDEZ RUIZ", true);

testMatch("AB08", "LPZ → LOPEZ",
  "MARIA LPZ. TORRES", "MARIA LOPEZ TORRES", true);

testMatch("AB09", "RMZ → RAMIREZ + FCO → FRANCISCO",
  "FCO. RMZ. DIAZ", "FRANCISCO RAMIREZ DIAZ", true);

testMatch("AB10", "GPE → GUADALUPE + HDZ → HERNANDEZ (solo abreviaciones)",
  "GPE. HDZ.", "GUADALUPE HERNANDEZ", true);

testMatch("AB11", "Nombre abreviado (JOSE F → JOSE FERNANDO)",
  "JOSE F CASTILLO VEGA", "JOSE FERNANDO CASTILLO VEGA", true);

testMatch("AB12", "Triple abreviación: MA. GPE. HDZ.",
  "MA. GPE. HDZ. FLORES", "MARIA GUADALUPE HERNANDEZ FLORES", true);

testMatch("AB13", "Parcial (2 de 3 tokens match)",
  "PEDRO LOPEZ", "PEDRO LOPEZ GARCIA", true);

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Nombres cortos solo abreviaciones — 5 tests
// Edge case crítico: cuando el documento solo tiene abreviaciones
// y el nombre real está en la INE
// ═══════════════════════════════════════════════════════════════

testMatch("SH01", "MA. HDZ. vs MARIA HERNANDEZ",
  "MA. HDZ.", "MARIA HERNANDEZ", true);

testMatch("SH02", "FCO. GZZ. vs FRANCISCO GONZALEZ",
  "FCO. GZZ.", "FRANCISCO GONZALEZ", true);

testMatch("SH03", "MA. MTZ. vs MARIA MARTINEZ",
  "MA. MTZ.", "MARIA MARTINEZ", true);

testMatch("SH04", "GPE. RDZ. vs GUADALUPE RODRIGUEZ",
  "GPE. RDZ.", "GUADALUPE RODRIGUEZ", true);

testMatch("SH05", "FCO. FDZ. vs FRANCISCO FERNANDEZ",
  "FCO. FDZ.", "FRANCISCO FERNANDEZ", true);

// ═══════════════════════════════════════════════════════════════
// SECTION 5: Partículas compuestas — match — 15 tests
// ═══════════════════════════════════════════════════════════════

testMatch("PC01", "DE LA CRUZ exacto",
  "MARIA GUADALUPE HERNANDEZ DE LA CRUZ", "MARIA GUADALUPE HERNANDEZ DE LA CRUZ", true);

testMatch("PC02", "DE LA CRUZ vs CRUZ simplificado (compound contains)",
  "MARIA HERNANDEZ DE LA CRUZ", "MARIA HERNANDEZ CRUZ", true);

testMatch("PC03", "DEL CASTILLO exacto",
  "JOSE DEL CASTILLO PEREZ", "JOSE DEL CASTILLO PEREZ", true);

testMatch("PC04", "DEL CASTILLO vs CASTILLO simplificado",
  "JOSE DEL CASTILLO PEREZ", "JOSE CASTILLO PEREZ", true);

testMatch("PC05", "DE LOS SANTOS exacto",
  "ANA DE LOS SANTOS GARCIA", "ANA DE LOS SANTOS GARCIA", true);

testMatch("PC06", "DE LOS SANTOS vs SANTOS simplificado",
  "ANA DE LOS SANTOS GARCIA", "ANA SANTOS GARCIA", true);

testMatch("PC07", "Orden invertido con partícula (bancario)",
  "DE LA ROSA MARTINEZ PEDRO", "PEDRO MARTINEZ DE LA ROSA", true);

testMatch("PC08", "Abreviación + partícula: HDZ. DE LA CRUZ",
  "MA. GPE. HDZ. DE LA CRUZ", "MARIA GUADALUPE HERNANDEZ DE LA CRUZ", true);

testMatch("PC09", "Múltiples partículas: DE LA + DEL",
  "JOSE DE LA TORRE DEL CAMPO", "JOSE DE LA TORRE DEL CAMPO", true);

testMatch("PC10", "DE LA TORRE vs TORRE (compound → simple)",
  "JOSE DE LA TORRE RAMIREZ", "JOSE TORRE RAMIREZ", true);

testMatch("PC11", "SAN JUAN compuesto",
  "PEDRO SAN JUAN LOPEZ", "PEDRO SAN JUAN LOPEZ", true);

testMatch("PC12", "Y como conector",
  "GARCIA Y LOPEZ MARIA", "MARIA GARCIA Y LOPEZ", true);

testMatch("PC13", "Caso real: INE con partícula vs factura sin partícula",
  "MARIA GUADALUPE HERNANDEZ DE LA CRUZ", "MA. GPE. HERNANDEZ CRUZ", true);

testMatch("PC14", "Caso real: estado de cuenta bancario con DE LA",
  "HERNANDEZ DE LA CRUZ MA GUADALUPE", "MARIA GUADALUPE HERNANDEZ DE LA CRUZ", true);

testMatch("PC15", "CSF nombre completo vs tarjeta con DE abreviado",
  "JOSE MANUEL ZAVALA DE LA FUENTE", "JOSE M. ZAVALA DE LA FUENTE", true);

// ═══════════════════════════════════════════════════════════════
// SECTION 6: Negativos — NO deben matchear — 9 tests
// ═══════════════════════════════════════════════════════════════

testMatch("NG01", "Personas completamente diferentes",
  "JUAN PEREZ SANCHEZ", "MARIA TORRES DIAZ", false);

testMatch("NG02", "Mismo nombre, apellidos diferentes",
  "PEDRO LOPEZ GARCIA", "PEDRO MARTINEZ RUIZ", false);

testMatch("NG03", "GONZALEZ vs GONZALES (typo tolerado — match aceptable)",
  "JUAN GONZALEZ PEREZ", "JUAN GONZALES PEREZ", true);

testMatch("NG04", "Solo 1 token coincide (insuficiente)",
  "RICARDO FUENTES MORENO", "RICARDO CASTILLO VEGA", false);

testMatch("NG05", "Abreviación incorrecta: HDZ. ≠ GONZALEZ",
  "MA. HDZ.", "MARIA GONZALEZ", false);

testMatch("NG06", "Nombres cortos completamente diferentes",
  "FCO. GZZ.", "MARIA HERNANDEZ", false);

testMatch("NG07", "Compuesto diferente: DE LA CRUZ vs DE LA TORRE (penalty)",
  "MARIA DE LA CRUZ HERNANDEZ", "MARIA DE LA TORRE HERNANDEZ", false);

testMatch("NG08", "Misma partícula, persona diferente",
  "JOSE DE LOS SANTOS GARCIA", "PEDRO DE LOS SANTOS LOPEZ", false);

testMatch("NG09", "DEL CASTILLO vs DEL CAMPO (compuesto diferente)",
  "ANA DEL CASTILLO PEREZ", "ANA DEL CAMPO PEREZ", false);

// ═══════════════════════════════════════════════════════════════
// SECTION 7: Edge cases adicionales — 9 tests
// ═══════════════════════════════════════════════════════════════

testMatch("ED01", "Nombre vacío vs nombre real (skip comparison)",
  "", "PEDRO LOPEZ", true);

testMatch("ED02", "Ambos vacíos",
  "", "", true);

testMatch("ED03", "Nombre muy corto (< 4 chars, skip)",
  "ANA", "ANA MARTINEZ LOPEZ", true);

testMatch("ED04", "Nombre con números (OCR error) — stripped by normalize",
  "PEDRO L0PEZ GARCIA", "PEDRO LOPEZ GARCIA", true);

testMatch("ED05", "Múltiples espacios",
  "PEDRO   LOPEZ    GARCIA", "PEDRO LOPEZ GARCIA", true);

testMatch("ED06", "Puntos en abreviación sin espacio: MA.GPE.",
  "MA.GPE. HDZ.", "MARIA GUADALUPE HERNANDEZ", true);

testMatch("ED07", "null vs nombre (safe)",
  null as any, "PEDRO LOPEZ", true);

testMatch("ED08", "Nombre con Ñ",
  "JOSE MUÑOZ PEÑA", "JOSE MUNOZ PENA", true);

testMatch("ED09", "Nombre con Ü (raro pero posible)",
  "JOSE GÜEMES LÓPEZ", "JOSE GUEMES LOPEZ", true);

// ═══════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════


  // Force execution of all tests above (they run on import)
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  console.log(`\n=== Name Matcher Tests (${results.length} cases) ===\n`);
  
  let currentSection = "";
  for (const r of results) {
    const section = r.id.replace(/\d+$/, "");
    if (section !== currentSection) {
      currentSection = section;
      const sectionNames: Record<string, string> = {
        JP: "joinParticles()",
        BM: "Basic matching",
        AB: "Abreviaciones mexicanas",
        SH: "Nombres cortos (abreviaciones)",
        PC: "Partículas compuestas",
        NG: "Negativos (no match)",
        ED: "Edge cases",
      };
      console.log(`\n── ${sectionNames[section] || section} ──\n`);
    }
    
    const icon = r.pass ? "✅" : "❌";
    console.log(`${icon} ${r.id}: ${r.description}`);
    if (!r.pass) {
      if (r.a !== undefined) console.log(`   "${r.a}" vs "${r.b}"`);
      if (r.tokensA) console.log(`   Tokens: [${r.tokensA.join(" | ")}] vs [${r.tokensB?.join(" | ")}]`);
      console.log(`   Expected: ${JSON.stringify(r.expected)}, Got: ${JSON.stringify(r.got)}`);
    }
  }

  console.log(`\n${passed}/${results.length} passed\n`);

  return { passed, failed, total: results.length, results };
}

// Run if executed directly
if (process.argv[1]?.includes('name-matcher')) {
  const r = runNameMatcherTests();
  if (r.failed > 0) process.exit(1);
}
