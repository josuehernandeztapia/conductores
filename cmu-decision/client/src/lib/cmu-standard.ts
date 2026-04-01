/**
 * CMU Program Standard — Configurable parameters
 * 
 * Values are initialized with hardcoded defaults, then updated dynamically
 * from the business_rules SSOT via updateStandardFromConfig().
 * This allows the app to work offline (defaults) and sync when backend is available.
 */

import type { BusinessConfig } from "./api";

// ===== Vehicle Eligibility =====
// NOTE: This object is MUTABLE — updateStandardFromConfig() patches it from the API.
export const STANDARD: {
  cmuMaximo: number; cmuMinimo: number;
  reparacionMinima: number; reparacionMaxima: number;
  tasaAnual: number; plazoMeses: number;
  anticipoCapital: number; anticipoMes: number;
  kitConTanque: number; kitSinTanque: number; plusSinTanque: number;
  gnvLeqMes: number; gnvPrecioLeq: number; gnvRevenueMes: number;
  fondoInicial: number; fondoMensual: number; fondoTecho: number;
  floatAmexDias: number; diasReparacion: number; diasColocacion: number; diasMuertos: number;
  tirBaseMinima: number;
  // Umbrales basados en porcentaje cuota/recaudo (SSOT)
  excelentePct: number; buenNegocioPctMin: number; buenNegocioPctMax: number;
  marginalPctMin: number; marginalPctMax: number; noConvienePct: number;
  // Legacy margin thresholds (kept for backward compat in UI text, but NOT used for classification)
  margenComprar: number; margenViable: number; margenMinimo: number;
  depositoMaxMes3: number; cuotaMaxMes1: number;
  anioMinimo: number;
  costoFondeo: number; spread: number;
  // Fuel prices
  precioGnvBase: number; precioMagna: number; precioPremium: number;
  checksVehiculo: readonly { readonly id: string; readonly label: string; readonly required: boolean }[];
} = {
  // CMU / Market Value
  cmuMaximo: 245000,
  cmuMinimo: 190000,

  // Acquisition
  reparacionMinima: 10000,
  reparacionMaxima: 30000,
  
  // Financial
  tasaAnual: 0.299,
  plazoMeses: 36,
  anticipoCapital: 50000,
  anticipoMes: 2,
  
  // Kit GNV
  kitConTanque: 18000,
  kitSinTanque: 27400,
  plusSinTanque: 9400,
  
  // GNV Revenue (defaults: 400 LEQ × $11 sobreprecio = $4,400)
  gnvLeqMes: 400,
  gnvPrecioLeq: 11,
  gnvRevenueMes: 4400,
  
  // Fondo de Garantía
  fondoInicial: 8000,
  fondoMensual: 334,
  fondoTecho: 20000,
  
  // Timing
  floatAmexDias: 50,
  diasReparacion: 15,
  diasColocacion: 10,
  diasMuertos: 25,
  
  // TIR thresholds
  tirBaseMinima: 0.299,
  
  // Umbrales porcentuales (cuota/recaudo GNV) — SSOT desde business_rules
  excelentePct: 0.80,
  buenNegocioPctMin: 0.80,
  buenNegocioPctMax: 0.90,
  marginalPctMin: 0.90,
  marginalPctMax: 1.00,
  noConvienePct: 1.00,

  // Legacy margin thresholds (display only)
  margenComprar: 40000,
  margenViable: 25000,
  margenMinimo: 15000,
  
  // Taxista capacity
  depositoMaxMes3: 5500,
  cuotaMaxMes1: 13000,
  
  // Vehicle age
  anioMinimo: 2021,
  
  // Funding (internal)
  costoFondeo: 0.21,
  spread: 0.089,
  
  // Fuel prices (defaults)
  precioGnvBase: 12.99,
  precioMagna: 24.00,
  precioPremium: 26.50,

  // Vehicle checks
  checksVehiculo: [
    { id: 'bolsas_aire', label: 'Bolsas de aire NO activadas', required: true },
    { id: 'motor_intacto', label: 'Motor sin daño por golpe', required: true },
    { id: 'no_reconstruccion', label: 'No es reconstrucción total', required: true },
    { id: 'origen', label: 'Origen: financiera o siniestro menor', required: false },
    { id: 'documentos', label: 'Factura y documentos disponibles', required: true },
    { id: 'verificacion', label: 'Verificación vehicular vigente', required: false },
  ],
};

/** Patch STANDARD with values from /api/business-config (SSOT) */
export function updateStandardFromConfig(config: BusinessConfig): void {
  // Consumo → GNV Revenue
  STANDARD.gnvLeqMes = config.leqBase;
  STANDARD.gnvPrecioLeq = config.sobreprecioGnv;
  STANDARD.gnvRevenueMes = config.gnvRevenueMes; // leqBase × sobreprecioGnv
  // Financiamiento
  STANDARD.tasaAnual = config.tasaAnual;
  STANDARD.tirBaseMinima = config.tasaAnual;
  STANDARD.plazoMeses = config.plazoMeses;
  // Fondo de Garantía
  STANDARD.fondoInicial = config.fgInicial;
  STANDARD.fondoMensual = config.fgMensual;
  STANDARD.fondoTecho = config.fgTecho;
  // Umbrales porcentuales
  STANDARD.excelentePct = config.excelentePct;
  STANDARD.buenNegocioPctMin = config.buenNegocioPctMin;
  STANDARD.buenNegocioPctMax = config.buenNegocioPctMax;
  STANDARD.marginalPctMin = config.marginalPctMin;
  STANDARD.marginalPctMax = config.marginalPctMax;
  STANDARD.noConvienePct = config.noConvienePct;
  // Fuel prices
  STANDARD.precioGnvBase = config.precioGnv;
  STANDARD.precioMagna = config.precioMagna;
  STANDARD.precioPremium = config.precioPremium;
  console.log(`[STANDARD] Synced from SSOT: gnvRevenue=$${STANDARD.gnvRevenueMes}, thresholds=${STANDARD.excelentePct}/${STANDARD.buenNegocioPctMax}/${STANDARD.noConvienePct}`);
}

// ===== Inverse Calculations =====

/** Given a CMU, what's the max total cost (aseg+rep+kit) for TIR Base >= 29.9%? */
export function maxCostoTotal(cmu: number, conTanque: boolean): number {
  // Since TIR Base at 29.9% allows cost very close to CMU,
  // the real constraint is the margin minimums
  const precioContado = conTanque ? cmu : cmu + STANDARD.plusSinTanque;
  const kit = conTanque ? STANDARD.kitConTanque : STANDARD.kitSinTanque;
  
  // For COMPRAR: margen >= $40k
  const maxParaComprar = precioContado - STANDARD.margenComprar;
  // For VIABLE: margen >= $25k  
  const maxParaViable = precioContado - STANDARD.margenViable;
  
  return maxParaComprar; // Return COMPRAR threshold
}

/** Given a CMU, what's the max you can pay for acquisition (aseg+rep)? */
export function maxAdquisicion(cmu: number, conTanque: boolean): number {
  const kit = conTanque ? STANDARD.kitConTanque : STANDARD.kitSinTanque;
  return maxCostoTotal(cmu, conTanque) - kit;
}

/** Given CMU and insurer price, what's the max repair for COMPRAR? */
export function maxReparacion(cmu: number, insurerPrice: number, conTanque: boolean): number {
  const maxAdq = maxAdquisicion(cmu, conTanque);
  const maxRep = maxAdq - insurerPrice;
  return Math.min(Math.max(0, maxRep), STANDARD.reparacionMaxima);
}

/** Given CMU, what's the min insurer price to generate a COMPRAR with rep=$10k? */
export function rangoAseguradora(cmu: number, conTanque: boolean): { min: number; maxComprar: number; maxViable: number } {
  const kit = conTanque ? STANDARD.kitConTanque : STANDARD.kitSinTanque;
  const precioContado = conTanque ? cmu : cmu + STANDARD.plusSinTanque;
  
  return {
    min: 0,
    maxComprar: precioContado - STANDARD.margenComprar - kit - STANDARD.reparacionMinima,
    maxViable: precioContado - STANDARD.margenViable - kit - STANDARD.reparacionMinima,
  };
}

/** Calculate cuota mes 3+ deposit for a given CMU (post-anticipo) */
export function depositoMes3(cmu: number, conTanque: boolean): number {
  const precioContado = conTanque ? cmu : cmu + STANDARD.plusSinTanque;
  const tasaMes = STANDARD.tasaAnual / 12;
  const capMes = Math.round(precioContado / STANDARD.plazoMeses);
  const saldoPost = precioContado - capMes * 2 - STANDARD.anticipoCapital;
  const capMes3 = Math.round(saldoPost / (STANDARD.plazoMeses - 2));
  const cuota3 = capMes3 + Math.round(saldoPost * tasaMes);
  return cuota3 - STANDARD.gnvRevenueMes;
}

/** Check if a CMU is within program range */
export function validarCmu(cmu: number): { valid: boolean; message: string } {
  if (cmu > STANDARD.cmuMaximo) {
    const dep = depositoMes3(cmu, true);
    return { valid: false, message: `CMU $${cmu.toLocaleString()} excede tope $${STANDARD.cmuMaximo.toLocaleString()}. Depósito mes 3+ sería $${dep.toLocaleString()} (máx $${STANDARD.depositoMaxMes3.toLocaleString()})` };
  }
  if (cmu < STANDARD.cmuMinimo) {
    return { valid: false, message: `CMU $${cmu.toLocaleString()} debajo del mínimo $${STANDARD.cmuMinimo.toLocaleString()}. Anticipo $50k representa ${Math.round(50000/cmu*100)}% del valor.` };
  }
  return { valid: true, message: 'Dentro del rango del programa' };
}
