import type { Model, VirtualModel } from "../types";
import type { EvaluationResult } from "../motor-financiero";
import { getThresholds, CMU } from "../motor-financiero";
import { StorageService } from "../storage-service";

export class EvaluationHandler {
  constructor(private storage: StorageService) {}

  parseEvalLine(line: string): {
    modelQuery: string | null;
    cost: number | null;
    repair: number | null;
    year: number | null;
    conTanque: boolean
  } {
    const lower = line.toLowerCase().trim();
    let cost: number | null = null;
    let repair: number | null = null;
    let year: number | null = null;
    let conTanque = true;

    // Extract year
    const yearMatch = lower.match(/20(2[1-9]|3[0-9])/);
    if (yearMatch) year = parseInt(yearMatch[0]);

    // Extract repair FIRST (before cost, so we don't confuse "rep 25k" with cost)
    const repMatch = lower.match(/(\d{1,3}(?:\.\d+)?)\s*k[,\s]+(?:de\s+)?rep(?:araci[oó]n)?\b/i)
      || lower.match(/(\d{1,3}(?:\.\d+)?)\s*k\s*,?\s*(?:de\s+)?rep(?:araci[oó]n)?\b/i)
      || lower.match(/rep(?:araci[oó]n)?(?:\s+(?:es\s+)?(?:de\s+)?)?\$?\s*(\d{1,3}(?:\.\d+)?)\s*(?:mil|k)/i)
      || lower.match(/rep(?:araci[oó]n)?(?:\s+(?:es\s+)?(?:de\s+)?)?\$?\s*(\d{1,3}),(\d{3})/i)
      || lower.match(/rep(?:araci[oó]n)?(?:\s+(?:es\s+)?(?:de\s+)?)?\$?\s*(\d{4,6})/i)
      || lower.match(/rep\s+(\d{1,3})\s*k?\b/i);

    if (repMatch) {
      if (repMatch[2]) {
        // "rep 25,000" format
        repair = parseInt(repMatch[1] + repMatch[2]);
      } else {
        const v = parseFloat(repMatch[1]);
        if (v < 1000) repair = Math.round(v * 1000);
        else repair = Math.round(v);
      }
    }

    // Remove the repair portion so it doesn't interfere with cost extraction
    let forCost = lower;
    if (repMatch) forCost = forCost.replace(repMatch[0], " ");

    // Extract cost patterns (in priority order)
    // Pattern 1: "95.5k" or "95,5k" (decimal/comma + k)
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

    // Two numbers without 'rep' = cost + repair
    if (cost && !repair) {
      const allKMatches = forCost.match(/(?:^|\s)(\d{2,3})\s*k\b/g);
      if (allKMatches && allKMatches.length >= 2) {
        const secondMatch = allKMatches[1].trim().match(/(\d{1,3})\s*k/);
        if (secondMatch) repair = parseInt(secondMatch[1]) * 1000;
      } else {
        const afterCostStr = forCost.replace(/(\d{2,3})\s*k\b/, "MATCHED").replace(/(\d{2,3})[,.](\d{3})/, "MATCHED");
        const secondComma = afterCostStr.match(/(\d{1,3})[,.](\d{3})/);
        if (secondComma) repair = parseInt(secondComma[1] + secondComma[2]);
      }
    }

    // Tank
    if (lower.includes("sin tanque") || lower.includes("tanque nuevo")) conTanque = false;

    // Model query: remove numbers, noise words
    let modelQuery: string | null = lower.replace(/josu[eé]\s*/i, "").replace(/eval[uú]a?\s*/i, "")
      .replace(/\d{2,3}[.,]\d{1,2}\s*k\b/g, "")
      .replace(/\d{2,3}\s*k\b/g, "")
      .replace(/\$?\s*\d{2,3}[,.}\d{3}/g, "")
      .replace(/\d{2,3}\s*mil/g, "")
      .replace(/\d{1,3}(?:\.\d+)?\s*k[,\s]+rep(?:araci[oó]n)?\b/gi, "")
      .replace(/rep(?:araci[oó]n)?(?:\s+(?:es\s+)?(?:de\s+)?)?\$?\s*\d+\s*k?/gi, "")
      .replace(/\brep(?:araci[oó]n)?\b/gi, "")
      .replace(/\$[\d,.]+/g, "").replace(/20\d{2}/g, "").replace(/sin tanque|tanque nuevo/gi, "")
      .replace(/\b(precio|precios|compra|costo|adquisici[oó]n|adquisicion|venta|me\s+lo|lo|venden|piden|en|de|la|el|es|y|con|del|al|mil|pesos)\b/gi, "")
      .replace(/\s+/g, " ").trim();

    if (modelQuery.length < 2) modelQuery = null;

    return { modelQuery, cost, repair, year, conTanque };
  }

  async resolveModel(query: string, year?: number | null): Promise<Model | undefined> {
    const models = await this.storage.getModels();
    const norm = (s: string) => s.toLowerCase().replace(/[\s\-]+/g, "");
    const q = norm(query);

    const nameMatches = models.filter((m: any) => {
      const slug = norm(`${m.model}${m.variant || ""}`);
      const slugFull = norm(`${m.brand}${m.model}${m.variant || ""}`);
      const dbSlug = norm(m.slug || "");
      return slug.includes(q) || q.includes(slug) || slugFull.includes(q) || dbSlug.includes(q) || q.includes(dbSlug);
    });

    if (nameMatches.length === 0) return undefined;

    if (year) {
      const exact = nameMatches.find((m: any) => m.year === year);
      if (exact) return exact as Model;

      const catalogYears = [...new Set(nameMatches.map((m: any) => m.year as number))];
      const closest = catalogYears.reduce((a, b) => Math.abs(b - year) < Math.abs(a - year) ? b : a);
      const diff = Math.abs(year - closest);

      console.log(`[ResolveModel] ${q} ${year} not in catalog (closest=${closest}, diff=${diff}) — triggering market flow`);
      return undefined;
    }

    const sorted = nameMatches.sort((a: any, b: any) => b.year - a.year);
    return sorted[0] as Model;
  }

  async getVariantsForModel(modelName: string): Promise<string[]> {
    try {
      const models = await this.storage.getModels();
      const normalizedQuery = modelName.toLowerCase().replace(/\s+/g, "");
      const matching = models.filter((m: any) => {
        const norm = (m.model || "").toLowerCase().replace(/\s+/g, "");
        return norm.includes(normalizedQuery) || normalizedQuery.includes(norm);
      });
      const variants = [...new Set(matching.map((m: any) => m.variant).filter(Boolean))];
      return variants as string[];
    } catch {
      return [];
    }
  }

  async autoInsertCatalogModel(
    brand: string,
    model: string,
    variant: string | null,
    year: number,
    cmu: number
  ): Promise<void> {
    try {
      const slug = `${brand}-${model}${variant ? "-" + variant : ""}`.toLowerCase().replace(/\s+/g, "-");
      await this.storage.createModel({
        brand, model, variant, year, cmu, slug,
        cmuSource: "mercado_auto",
        purchaseBenchmarkPct: 0.65,
        cmuUpdatedAt: new Date().toISOString(),
      } as any);
      console.log(`[Catalog] Auto-inserted: ${brand} ${model} ${variant || ""} ${year} CMU=$${cmu}`);
    } catch (e: any) {
      console.error(`[Catalog] Auto-insert failed: ${e.message}`);
    }
  }

  formatEvalResult(
    r: EvaluationResult,
    marketData?: {
      avg: number | null;
      min: number | null;
      max: number | null;
      median: number | null;
      count: number;
      sources: string;
      fallback: boolean
    },
    gnvRevenue?: number,
    thresholds?: ReturnType<typeof getThresholds>
  ): string {
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

    // Guardrails
    const gPassed = r.guardrailsPassed;
    const gTotal = r.guardrails.length;
    lines.push(
      ``,
      `*FILTROS (${gPassed}/${gTotal})*`,
    );
    for (const g of r.guardrails) {
      lines.push(`${g.passed ? "✅" : "❌"} ${g.label}: ${g.value} (${g.threshold})`);
    }

    // Risk assessment
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

  isConversational(text: string): boolean {
    const lower = text.toLowerCase();
    if (lower.includes("?")) return true;
    if (/^(hola|oye|podr[ií]as?|puedes|quer[ií]a|necesito|me |como |qu[eé] |hay |cu[aá]ndo|d[oó]nde|por qu[eé]|sabes|dime|oiga|mande|buenos? |buenas?)/.test(lower)) return true;
    const words = lower.split(/\s+/).length;
    if (words > 6 && !/\d{2,3}\s*k|rep\s*\d/i.test(lower)) return true;
    return false;
  }

  extractModelFromNaturalText(text: string): {
    modelName: string | null;
    brand: string | null;
    year: number | null
  } {
    const lower = text.toLowerCase();
    let found: string | null = null;

    for (const m of KNOWN_MODELS) {
      if (lower.includes(m)) {
        found = m;
        break;
      }
    }

    const brand = found ? (BRAND_MAP[found] || null) : null;
    const yearMatch = lower.match(/20(2[1-9]|3[0-9])/);

    if (!found) {
      const noise = /\b(precio|precios|mercado|market|dame|dime|dar|del|de|la|el|los|las|un|una|cuanto|cu[aá]nto|cuesta|vale|promedio|busca|buscar|quiero|ver|ahora|tambi[eé]n|nuevo|nueva|sedan|hatchback|me|te|se|nos|si|s[ií]|no|por|para|que|qu[eé]|como|c[oó]mo|con|sin|su|sus|al|pero|ya|hay|puede|puedes|podr[ií]as?|dar|tiene|tengo|cuentas?|cuenta|favor|hola|oye|oiga|bueno|pues|ese|esa|este|esta|esto|estos|estas|esos|esas|solo|s[oó]lo|cual|donde|cuando|porque|porqu[eé]|ser|son|era|fue|api|eso|otro|otra|otros|otras|bien|mal|muy|mas|m[aá]s|algo|nada|todo|todos|cada|mismo|aqu[ií]|ahi|ah[ií]|alla|all[aá]|venden|piden|reparaci[oó]n|reparacion|rep)\b/g;
      const cleaned = lower.replace(noise, "").replace(/20\d{2}/g, "").replace(/[?!¿¡.,;:]/g, "")
        .replace(/\d{2,3}\s*k\b/g, "").replace(/\$?\s*\d{2,3}[,.}\d{3}/g, "").replace(/\d{5,6}/g, "")
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
          if (!brand && extractedBrand) {
            return {
              modelName: found,
              brand: extractedBrand,
              year: yearMatch ? parseInt(yearMatch[0]) : null
            };
          }
        }
      }
    }

    return {
      modelName: found,
      brand,
      year: yearMatch ? parseInt(yearMatch[0]) : null
    };
  }
}

// Brand mapping: model name -> brand
const BRAND_MAP: Record<string, string> = {
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

// Known model names ordered longest-first
const KNOWN_MODELS = [
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