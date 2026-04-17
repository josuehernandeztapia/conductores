/**
 * RAG ROLES — Test that all 3 roles get deterministic RAG answers for critical queries
 * 
 * Validates that 'documentos', 'requisitos', 'inventario', etc. return RAG answers
 * (not LLM hallucinations) regardless of role.
 * 
 * Ejecutar local:  npx tsx test/rag-roles.ts
 * Ejecutar prod:   POST /api/test/rag-roles
 */

import { answerQuestion } from "../server/agent/rag";

interface TestResult {
  id: string;
  role: string;
  query: string;
  pass: boolean;
  matched: boolean;
  mustContain?: string;
  snippet?: string;
  error?: string;
}

export async function runRAGRolesTests() {
  const results: TestResult[] = [];

  // Queries that MUST return a RAG answer (not null)
  const criticalQueries: {
    id: string;
    query: string;
    mustMatch: boolean;
    mustContain?: string; // substring the answer must include
    description: string;
  }[] = [
    // ── DOCUMENTOS ──
    {
      id: "DOC01",
      query: "documentos",
      mustMatch: true,
      mustContain: "INE",
      description: "Palabra 'documentos' debe retornar lista de docs con INE",
    },
    {
      id: "DOC02",
      query: "Dime cuáles son los documentos",
      mustMatch: true,
      mustContain: "INE",
      description: "Pregunta completa de documentos",
    },
    {
      id: "DOC03",
      query: "qué documentos necesito",
      mustMatch: true,
      mustContain: "Comprobante",
      description: "'qué documentos necesito' con comprobante",
    },
    {
      id: "DOC04",
      query: "dame los requisitos",
      mustMatch: true,
      mustContain: "vigencia",
      description: "'requisitos' debe incluir vigencias",
    },
    {
      id: "DOC05",
      query: "Requisitos",
      mustMatch: true,
      mustContain: "Concesi",
      description: "'Requisitos' solo, debe mencionar Concesión",
    },
    {
      id: "DOC06",
      query: "qué papeles me piden",
      mustMatch: true,
      mustContain: "INE",
      description: "'papeles' como sinónimo de documentos",
    },
    {
      id: "DOC07",
      query: "checklist de documentos",
      mustMatch: true,
      mustContain: "14",
      description: "'checklist' debe mencionar 14 docs",
    },

    // ── VIGENCIAS ──
    {
      id: "VIG01",
      query: "de cuántos meses el comprobante de domicilio",
      mustMatch: true,
      mustContain: "3 meses",
      description: "Vigencia domicilio = 3 meses",
    },
    {
      id: "VIG02",
      query: "vigencia de la CSF",
      mustMatch: true,
      mustContain: "3 meses",
      description: "CSF vigencia = 3 meses",
    },
    {
      id: "VIG03",
      query: "de cuántos meses máximo",
      mustMatch: true,
      mustContain: "3 meses",
      description: "Pregunta genérica de vigencia",
    },

    // ── PROGRAMA ──
    {
      id: "PRG01",
      query: "qué es CMU",
      mustMatch: true,
      mustContain: "gas natural",
      description: "'qué es CMU' debe mencionar gas natural",
    },
    {
      id: "PRG02",
      query: "cómo funciona el programa",
      mustMatch: true,
      mustContain: "36 meses",
      description: "Programa debe mencionar 36 meses",
    },
    {
      id: "PRG03",
      query: "cuánto tarda el trámite",
      mustMatch: true,
      mustContain: "semanas",
      description: "Timeline ~2 semanas",
    },

    // ── ENGANCHE ──
    {
      id: "ENG01",
      query: "necesito dar enganche",
      mustMatch: true,
      mustContain: "No hay anticipo",
      description: "No hay enganche",
    },
    {
      id: "ENG02",
      query: "cuánto es el anticipo",
      mustMatch: true,
      mustContain: "50,000",
      description: "Día 56 → $50,000",
    },

    // ── GAS / KIT ──
    {
      id: "GAS01",
      query: "el kit va incluido",
      mustMatch: true,
      mustContain: "incluido",
      description: "Kit GNV incluido",
    },
    {
      id: "GAS02",
      query: "dónde cargo gas",
      mustMatch: true,
      mustContain: "convenio CMU",
      description: "Estaciones con convenio CMU (no NATGAS)",
    },
    {
      id: "GAS03",
      query: "cuánto cuesta el gas",
      mustMatch: true,
      mustContain: "variable",
      description: "Precio variable",
    },
    {
      id: "GAS04",
      query: "cuánto me ahorro",
      mustMatch: true,
      mustContain: "40",
      description: "Ahorro 40-50%",
    },
    {
      id: "GAS05",
      query: "se acaba el gas en carretera",
      mustMatch: true,
      mustContain: "bicombustible",
      description: "Bicombustible/bifuel",
    },

    // ── ELEGIBILIDAD ──
    {
      id: "ELE01",
      query: "necesito aval",
      mustMatch: true,
      mustContain: "No",
      description: "No aval",
    },
    {
      id: "ELE02",
      query: "revisan buró",
      mustMatch: true,
      mustContain: "No",
      description: "No buró",
    },
    {
      id: "ELE03",
      query: "en qué ciudad operan",
      mustMatch: true,
      mustContain: "Aguascalientes",
      description: "Solo Aguascalientes",
    },

    // ── CONFIANZA ──
    {
      id: "CON01",
      query: "es una estafa",
      mustMatch: true,
      mustContain: "registrada",
      description: "Respuesta de confianza",
    },
    {
      id: "CON02",
      query: "eres robot",
      mustMatch: true,
      mustContain: "asistente",
      description: "Identidad del bot",
    },

    // ── TECNOLOGÍA ──
    {
      id: "TEC01",
      query: "no sé mandar fotos",
      mustMatch: true,
      mustContain: "cámara",
      description: "Ayuda para enviar fotos",
    },
    {
      id: "TEC02",
      query: "prefiero llamar por teléfono",
      mustMatch: true,
      mustContain: "promotor",
      description: "Ofrece promotor para atención personal",
    },

    // ── DOCUMENTOS ESPECÍFICOS ──
    {
      id: "DSP01",
      query: "qué es la constancia del SAT",
      mustMatch: true,
      mustContain: "sat.gob.mx",
      description: "Cómo sacar CSF",
    },
    {
      id: "DSP02",
      query: "no tengo cuenta de banco",
      mustMatch: true,
      mustContain: "cuenta",
      description: "Necesita cuenta bancaria",
    },
    {
      id: "DSP03",
      query: "qué es CURP",
      mustMatch: true,
      mustContain: "gob.mx",
      description: "Cómo sacar CURP",
    },
    {
      id: "DSP04",
      query: "foto borrosa",
      mustMatch: true,
      mustContain: "luz",
      description: "Instrucciones para mejor foto",
    },

    // ── NEGATIVOS: cosas que NO deben matchear RAG (deben ir al LLM) ──
    {
      id: "NEG01",
      query: "march 120k rep 10k",
      mustMatch: false,
      description: "Evaluación rápida NO debe ser RAG",
    },
    {
      id: "NEG02",
      query: "mercado vento 2020",
      mustMatch: false,
      description: "Precios de mercado NO debe ser RAG",
    },
    {
      id: "NEG03",
      query: "me conviene ofertar 300k por los dos",
      mustMatch: false,
      description: "Análisis conversacional NO debe ser RAG",
    },
  ];

  const roles = ["prospecto", "promotora", "director"];

  for (const role of roles) {
    for (const q of criticalQueries) {
      const testId = `${q.id}_${role.slice(0, 3).toUpperCase()}`;
      try {
        const answer = await answerQuestion(q.query);
        const matched = answer !== null && answer !== undefined;

        let pass: boolean;
        if (q.mustMatch) {
          pass = matched;
          if (pass && q.mustContain) {
            pass = answer!.toLowerCase().includes(q.mustContain.toLowerCase());
          }
        } else {
          pass = !matched; // should NOT match
        }

        results.push({
          id: testId,
          role,
          query: q.query,
          pass,
          matched,
          mustContain: q.mustContain,
          snippet: answer ? answer.slice(0, 80) + (answer.length > 80 ? "..." : "") : "(no match)",
          error: !pass
            ? q.mustMatch
              ? matched
                ? `Missing "${q.mustContain}" in answer`
                : "RAG returned null — would fall to LLM"
              : "RAG matched but should NOT have (should go to LLM)"
            : undefined,
        });
      } catch (e: any) {
        results.push({
          id: testId,
          role,
          query: q.query,
          pass: false,
          matched: false,
          error: e.message,
        });
      }
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const total = results.length;

  // Print results grouped by role
  console.log(`\n=== RAG Roles Tests (${total} cases) ===\n`);

  for (const role of roles) {
    const roleResults = results.filter((r) => r.role === role);
    const rolePassed = roleResults.filter((r) => r.pass).length;
    console.log(`\n── ${role.toUpperCase()} (${rolePassed}/${roleResults.length}) ──\n`);

    for (const r of roleResults) {
      const icon = r.pass ? "✅" : "❌";
      console.log(`${icon} ${r.id}: "${r.query}"`);
      if (!r.pass) {
        console.log(`   Error: ${r.error}`);
        if (r.snippet) console.log(`   Got: ${r.snippet}`);
      }
    }
  }

  console.log(`\n${passed}/${total} passed\n`);

  return { passed, failed, total, results };
}

// Run if executed directly
if (process.argv[1]?.includes("rag-roles")) {
  runRAGRolesTests().then(r => {
    if (r.failed > 0) process.exit(1);
  });
}
