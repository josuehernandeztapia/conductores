// server/config.ts — Single Source of Truth for CMU business constants
// Values read from business_rules DB with hardcoded fallbacks

import { neon } from "@neondatabase/serverless";

// Helper to read from business_rules (lazy, cached)
let _rules: Record<string, string> | null = null;
async function getRulesCached(): Promise<Record<string, string>> {
  if (_rules) return _rules;
  try {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) { _rules = {}; return _rules; }
    const sql = neon(dbUrl);
    const rows = await sql`SELECT key, value FROM business_rules`;
    _rules = Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    setTimeout(() => { _rules = null; }, 5 * 60 * 1000); // 5min cache
  } catch { _rules = {}; }
  return _rules!;
}

export function ruleNum(key: string, fallback: number): () => Promise<number> {
  return async () => {
    const rules = await getRulesCached();
    const v = parseFloat(rules[key] || "");
    return isNaN(v) ? fallback : v;
  };
}
export function ruleStr(key: string, fallback: string): () => Promise<string> {
  return async () => {
    const rules = await getRulesCached();
    return rules[key] || fallback;
  };
}

// Sync versions for non-async contexts (use fallbacks only — call DB version where possible)
export const CMU_DEFAULTS = {
  clabe: "152680120000787681",
  banco: "Bancrea",
  rfc: "CMU201119DD6",
  razonSocial: "Conductores del Mundo, S.A.P.I. de C.V.",
  tasaAnual: 0.299,
  plazoMeses: 36,
  anticipo: 50000,
  fondoInicial: 8000,
  fondoMensual: 334,
  fondoTecho: 20000,
  kitConTanque: 18000,  // Cliente reutiliza su tanque — solo kit de conversión
  kitSinTanque: 27400,  // Cliente sin tanque — kit + tanque nuevo ($9,400 extra)
  sobreprecioGnv: 11,
  recaudoBase: 4400,
  moraFee: 250,
  moraPct: 0.02,
  paymentDeadlineDay: 5,
  fgKickInDay: 6,
} as const;
