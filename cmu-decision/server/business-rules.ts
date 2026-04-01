/**
 * Business Rules — Single Source of Truth (SSOT)
 * Reads from business_rules table in Neon
 * Cached in memory with 5-minute TTL
 */

import { neon } from "@neondatabase/serverless";

export type BusinessRule = {
  key: string;
  value: string;
  type: string; // "number" | "boolean" | "string"
  category: string;
  description: string;
};

type RulesMap = Map<string, BusinessRule>;

let cachedRules: RulesMap | null = null;
let cachedAt = 0;
const TTL = 5 * 60 * 1000; // 5 minutes

export async function getBusinessRules(): Promise<RulesMap> {
  if (cachedRules && Date.now() - cachedAt < TTL) return cachedRules;

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn("[BusinessRules] No DATABASE_URL, using defaults");
    return getDefaults();
  }

  try {
    const sql = neon(dbUrl);
    const rows = await sql`SELECT key, value, value_type, category, description FROM business_rules`;
    const map: RulesMap = new Map();
    for (const r of rows) {
      map.set(r.key, {
        key: r.key,
        value: r.value,
        type: r.value_type,
        category: r.category,
        description: r.description || "",
      });
    }
    cachedRules = map;
    cachedAt = Date.now();
    console.log(`[BusinessRules] Loaded ${map.size} rules from DB`);
    return map;
  } catch (e: any) {
    console.error("[BusinessRules] DB error, using defaults:", e.message);
    return getDefaults();
  }
}

export function getRulesByCategory(rules: RulesMap, category: string): BusinessRule[] {
  return Array.from(rules.values()).filter(r => r.category === category);
}

export function getRuleValue(rules: RulesMap, key: string): any {
  const rule = rules.get(key);
  if (!rule) return undefined;
  switch (rule.type) {
    case "number": return parseFloat(rule.value);
    case "boolean": return rule.value === "true";
    default: return rule.value;
  }
}

// Convenience: get a number with fallback
export function ruleNum(rules: RulesMap, key: string, fallback: number): number {
  const v = getRuleValue(rules, key);
  return typeof v === "number" && !isNaN(v) ? v : fallback;
}

// Convenience: get a string with fallback
export function ruleStr(rules: RulesMap, key: string, fallback: string): string {
  const v = getRuleValue(rules, key);
  return typeof v === "string" ? v : fallback;
}

// Convenience: get a boolean with fallback
export function ruleBool(rules: RulesMap, key: string, fallback: boolean): boolean {
  const v = getRuleValue(rules, key);
  return typeof v === "boolean" ? v : fallback;
}

// Extract threshold object for evaluation engine
export function getThresholds(rules: RulesMap) {
  return {
    excellentPct: ruleNum(rules, "excelente_pct", 0.80),
    goodPctMin: ruleNum(rules, "buen_negocio_pct_min", 0.80),
    goodPctMax: ruleNum(rules, "buen_negocio_pct_max", 0.90),
    marginalPctMin: ruleNum(rules, "marginal_pct_min", 0.90),
    marginalPctMax: ruleNum(rules, "marginal_pct_max", 1.00),
    noConvienePct: ruleNum(rules, "no_conviene_pct", 1.00),
  };
}

// Build text summary of rules for LLM injection
export function buildRulesContext(rules: RulesMap): string {
  const lines: string[] = [];

  // Thresholds
  const t = getThresholds(rules);
  lines.push(`UMBRALES DE DECISION (de business_rules DB):`);
  lines.push(`- %CMU < ${(t.excellentPct * 100).toFixed(0)}%: EXCELENTE`);
  lines.push(`- ${(t.goodPctMin * 100).toFixed(0)}%-${(t.goodPctMax * 100).toFixed(0)}%: BUEN NEGOCIO`);
  lines.push(`- ${(t.marginalPctMin * 100).toFixed(0)}%-${(t.marginalPctMax * 100).toFixed(0)}%: MARGINAL`);
  lines.push(`- >${(t.noConvienePct * 100).toFixed(0)}%: NO CONVIENE`);

  // Agent rules
  const agentRules = getRulesByCategory(rules, "agente");
  if (agentRules.length > 0) {
    lines.push(``, `REGLAS DEL AGENTE:`);
    for (const r of agentRules) lines.push(`- ${r.description || r.value}`);
  }

  // Consumption rules
  lines.push(``, `CONSUMO GNV:`);
  lines.push(`- Base: ${ruleNum(rules, "leq_base", 400)} LEQ/mes`);
  lines.push(`- Minimo aceptado: ${ruleNum(rules, "leq_minimo", 300)} LEQ/mes`);
  lines.push(`- Rango real: ${ruleStr(rules, "leq_rango_real", "300-500")} LEQ/mes`);

  // Fondo de Garantia
  lines.push(``, `FONDO DE GARANTIA:`);
  lines.push(`- Inicial: $${ruleNum(rules, "fg_inicial", 8000).toLocaleString()}`);
  lines.push(`- Mensual: $${ruleNum(rules, "fg_mensual", 334)}`);
  lines.push(`- Techo: $${ruleNum(rules, "fg_techo", 20000).toLocaleString()}`);
  lines.push(`- Devoluible: ${ruleBool(rules, "fg_devoluible", true) ? "SI" : "NO"}`);

  // Cobranza
  lines.push(``, `COBRANZA:`);
  lines.push(`- Mora: $${ruleNum(rules, "mora_fee", 250)}`);
  lines.push(`- Rescision: ${ruleNum(rules, "meses_rescision", 3)} meses consecutivos`);
  lines.push(`- Flujo: ${ruleStr(rules, "flujo_cobranza", "FG -> Conekta -> mora -> rescision")}`);

  // Legal requirements
  const legalRules = getRulesByCategory(rules, "legal");
  if (legalRules.length > 0) {
    lines.push(``, `REQUISITOS LEGALES:`);
    for (const r of legalRules) {
      lines.push(`- ${r.description || r.key}`);
    }
  }

  return lines.join("\n");
}

// Defaults (used when DB is not available)
function getDefaults(): RulesMap {
  const defaults: [string, string, string, string][] = [
    ["plazo_meses", "36", "number", "financiamiento"],
    ["tasa_anual", "0.299", "number", "financiamiento"],
    ["fg_inicial", "8000", "number", "fondo_garantia"],
    ["fg_mensual", "334", "number", "fondo_garantia"],
    ["fg_techo", "20000", "number", "fondo_garantia"],
    ["fg_devoluible", "true", "boolean", "fondo_garantia"],
    ["leq_base", "400", "number", "consumo"],
    ["leq_minimo", "300", "number", "consumo"],
    ["mora_fee", "250", "number", "cobranza"],
    ["meses_rescision", "3", "number", "cobranza"],
    ["excelente_pct", "0.80", "number", "umbrales"],
    ["buen_negocio_pct_min", "0.80", "number", "umbrales"],
    ["buen_negocio_pct_max", "0.90", "number", "umbrales"],
    ["marginal_pct_min", "0.90", "number", "umbrales"],
    ["marginal_pct_max", "1.00", "number", "umbrales"],
    ["no_conviene_pct", "1.00", "number", "umbrales"],
  ];
  const map: RulesMap = new Map();
  for (const [k, v, t, c] of defaults) {
    map.set(k, { key: k, value: v, type: t, category: c, description: "" });
  }
  return map;
}
