/**
 * Promotor Dashboard Engine
 *
 * Genera el panel de trabajo para un promotor: sus folios agrupados por
 * estado + alertas + lista de docs faltantes por folio + KPIs mensuales.
 *
 * Multi-promotor desde el inicio:
 *  - Input: promoterDbId (número) + promotorId genérico (string, p.ej. "promotor_uno")
 *  - La UI NUNCA muestra nombres personales — solo labels genéricos.
 */

import type { Origination } from "../shared/schema";
import { PROMOTORES, getPromotorBy } from "./team-config";

// ===== Tipos =====

export interface DashboardFolio {
  id: number;
  folio: string;
  tipo: string;
  estado: string;
  taxistaNombre: string | null;
  taxistaTelefono: string | null;
  currentStep: number;
  diasDesdeCreacion: number;
  diasDesdeActualizacion: number;
  docsCapturados: number;
  docsFaltantes: string[];
  siguientePaso: string;
  urgencia: "ok" | "watch" | "alert" | "critical";
  createdAt: string;
  updatedAt: string;
}

export interface DashboardBucket {
  key: string;
  titulo: string;
  descripcion: string;
  count: number;
  items: DashboardFolio[];
}

export interface DashboardAlert {
  severity: "info" | "warning" | "critical";
  code: string;
  title: string;
  message: string;
  foliosAfectados: string[];
  action?: string;
}

export interface DashboardKPIs {
  mesActual: string; // YYYY-MM
  totalActivos: number;
  totalFirmadosEsteMes: number;
  totalPerdidosEsteMes: number;
  totalRechazadosEsteMes: number;
  conversionRate: number; // firmados / (firmados + perdidos + rechazados)
}

export interface PromotorDashboard {
  promotor: { id: string; label: string };
  timestamp: string;
  alerts: DashboardAlert[];
  buckets: DashboardBucket[];
  kpis: DashboardKPIs;
}

// ===== Configuración de docs requeridos por tipo =====

const DOCS_REQUERIDOS: Record<string, Array<{ key: string; label: string; jsonField: string }>> = {
  validacion: [
    { key: "ine", label: "INE (frente y reverso)", jsonField: "datosIne" },
    { key: "csf", label: "Constancia SAT (CSF)", jsonField: "datosCsf" },
    { key: "comprobante", label: "Comprobante de domicilio", jsonField: "datosComprobante" },
    { key: "concesion", label: "Concesión", jsonField: "datosConcesion" },
    { key: "factura", label: "Factura del vehículo", jsonField: "datosFactura" },
    { key: "historial", label: "Historial GNV / gasolina", jsonField: "datosHistorial" },
  ],
  compraventa: [
    { key: "ine", label: "INE", jsonField: "datosIne" },
    { key: "csf", label: "Constancia SAT (CSF)", jsonField: "datosCsf" },
    { key: "comprobante", label: "Comprobante de domicilio", jsonField: "datosComprobante" },
    { key: "factura", label: "Factura / título", jsonField: "datosFactura" },
    { key: "estado_cuenta", label: "Estado de cuenta bancario", jsonField: "datosEstadoCuenta" },
  ],
};

function docsStatus(orig: Origination): { capturados: number; faltantes: string[] } {
  const tipo = orig.tipo || "validacion";
  const required = DOCS_REQUERIDOS[tipo] || DOCS_REQUERIDOS.validacion;
  const faltantes: string[] = [];
  let capturados = 0;
  for (const doc of required) {
    const val = (orig as any)[doc.jsonField];
    if (val && String(val).length > 4) capturados++;
    else faltantes.push(doc.label);
  }
  return { capturados, faltantes };
}

function diasDesde(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
}

/**
 * Por estado + días sin actualización, determina urgencia:
 *  - critical: >7 días sin mover en estado incompleto → casi perdido
 *  - alert: >5 días sin mover o requiere acción del promotor
 *  - watch: 3-5 días sin mover
 *  - ok: todo bajo control
 */
function calcularUrgencia(orig: Origination): DashboardFolio["urgencia"] {
  const dias = diasDesde(orig.updatedAt);
  const estado = orig.estado || "BORRADOR";
  if (["FIRMADO", "APROBADO"].includes(estado)) return "ok";
  if (estado === "INCOMPLETO" || estado === "RECHAZADO") {
    return dias > 7 ? "critical" : "alert";
  }
  if (["BORRADOR", "CAPTURANDO"].includes(estado)) {
    if (dias > 7) return "critical";
    if (dias > 5) return "alert";
    if (dias > 3) return "watch";
  }
  if (estado === "VALIDADO") {
    // Esperando aprobación del director → no es culpa del promotor, solo watch si pasan 2 días
    return dias > 3 ? "watch" : "ok";
  }
  if (estado === "GENERADO") {
    // Contrato generado, esperando firma — >3 días es alert
    if (dias > 5) return "alert";
    if (dias > 3) return "watch";
  }
  return "ok";
}

function siguientePaso(orig: Origination, docs: { faltantes: string[] }): string {
  const estado = orig.estado || "BORRADOR";
  if (estado === "BORRADOR" || estado === "CAPTURANDO") {
    if (docs.faltantes.length > 0) return `Capturar: ${docs.faltantes.slice(0, 2).join(", ")}${docs.faltantes.length > 2 ? "..." : ""}`;
    return "Enviar a validación CMU";
  }
  if (estado === "VALIDADO") return "Esperando evaluación del motor CMU";
  if (estado === "GENERADO") return "Pendiente de firma en Mifiel";
  if (estado === "FIRMADO") return "Firmado — completado";
  if (estado === "INCOMPLETO") return "Completar docs y re-enviar";
  if (estado === "RECHAZADO") return "Rechazado — ver motivo";
  if (estado === "APROBADO") return "Aprobado — listo";
  return "Revisar estado";
}

function toDashboardFolio(orig: Origination, taxista: any): DashboardFolio {
  const docs = docsStatus(orig);
  return {
    id: orig.id,
    folio: orig.folio,
    tipo: orig.tipo,
    estado: orig.estado,
    taxistaNombre: taxista ? `${taxista.nombre} ${taxista.apellidoPaterno || ""}`.trim() : null,
    taxistaTelefono: taxista?.telefono || (orig as any).otpPhone || null,
    currentStep: orig.currentStep,
    diasDesdeCreacion: diasDesde(orig.createdAt),
    diasDesdeActualizacion: diasDesde(orig.updatedAt),
    docsCapturados: docs.capturados,
    docsFaltantes: docs.faltantes,
    siguientePaso: siguientePaso(orig, docs),
    urgencia: calcularUrgencia(orig),
    createdAt: orig.createdAt,
    updatedAt: orig.updatedAt,
  };
}

// ===== Agrupar en buckets =====

function groupIntoBuckets(folios: DashboardFolio[]): DashboardBucket[] {
  const pendienteDocs = folios.filter(f => ["BORRADOR", "CAPTURANDO"].includes(f.estado));
  const esperandoEval = folios.filter(f => f.estado === "VALIDADO");
  const listosFirma = folios.filter(f => f.estado === "GENERADO");
  const firmados = folios.filter(f => f.estado === "FIRMADO" || f.estado === "APROBADO");
  const incompletos = folios.filter(f => ["INCOMPLETO", "RECHAZADO"].includes(f.estado));

  const sortByUrgencia = (a: DashboardFolio, b: DashboardFolio) => {
    const order = { critical: 0, alert: 1, watch: 2, ok: 3 };
    return order[a.urgencia] - order[b.urgencia];
  };

  return [
    {
      key: "pendiente_docs",
      titulo: "Pendientes de documentos",
      descripcion: "Folios donde estás capturando o te falta documentación",
      count: pendienteDocs.length,
      items: pendienteDocs.sort(sortByUrgencia),
    },
    {
      key: "esperando_eval",
      titulo: "En evaluación CMU",
      descripcion: "Docs completos, esperando motor CMU",
      count: esperandoEval.length,
      items: esperandoEval.sort(sortByUrgencia),
    },
    {
      key: "listos_firma",
      titulo: "Listos para firma",
      descripcion: "Contrato generado, pendiente firma del cliente",
      count: listosFirma.length,
      items: listosFirma.sort(sortByUrgencia),
    },
    {
      key: "incompletos",
      titulo: "Requieren acción",
      descripcion: "Rechazados o incompletos que hay que trabajar",
      count: incompletos.length,
      items: incompletos.sort(sortByUrgencia),
    },
    {
      key: "firmados",
      titulo: "Firmados",
      descripcion: "Completados (historial)",
      count: firmados.length,
      items: firmados.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10),
    },
  ];
}

// ===== Alertas =====

function generarAlertas(folios: DashboardFolio[]): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];

  const criticos = folios.filter(f => f.urgencia === "critical");
  if (criticos.length > 0) {
    alerts.push({
      severity: "critical",
      code: "FOLIOS_CRITICOS",
      title: `${criticos.length} folios sin movimiento hace 7+ días`,
      message: "Estos folios están a punto de perderse. Contacta al cliente hoy.",
      foliosAfectados: criticos.map(f => f.folio),
      action: "Contactar cliente",
    });
  }

  const alertas = folios.filter(f => f.urgencia === "alert");
  if (alertas.length > 0) {
    alerts.push({
      severity: "warning",
      code: "FOLIOS_ALERTA",
      title: `${alertas.length} folios requieren seguimiento`,
      message: "Llevan 5+ días sin avance.",
      foliosAfectados: alertas.map(f => f.folio),
    });
  }

  const rechazados = folios.filter(f => f.estado === "RECHAZADO");
  if (rechazados.length > 0) {
    alerts.push({
      severity: "warning",
      code: "FOLIOS_RECHAZADOS",
      title: `${rechazados.length} folios rechazados`,
      message: "Revisa motivo y decide si re-capturar o cerrar.",
      foliosAfectados: rechazados.map(f => f.folio),
    });
  }

  return alerts;
}

// ===== KPIs =====

function calcularKPIs(folios: DashboardFolio[]): DashboardKPIs {
  const mesActual = new Date().toISOString().slice(0, 7);
  const enMes = (iso: string) => iso.startsWith(mesActual);

  const activos = folios.filter(f => !["FIRMADO", "APROBADO", "RECHAZADO"].includes(f.estado));
  const firmadosEsteMes = folios.filter(f => (f.estado === "FIRMADO" || f.estado === "APROBADO") && enMes(f.updatedAt));
  const rechazadosEsteMes = folios.filter(f => f.estado === "RECHAZADO" && enMes(f.updatedAt));
  const perdidosEsteMes = folios.filter(f => f.estado === "INCOMPLETO" && f.urgencia === "critical" && enMes(f.updatedAt));

  const totalCerrados = firmadosEsteMes.length + rechazadosEsteMes.length + perdidosEsteMes.length;
  const conversionRate = totalCerrados > 0 ? firmadosEsteMes.length / totalCerrados : 0;

  return {
    mesActual,
    totalActivos: activos.length,
    totalFirmadosEsteMes: firmadosEsteMes.length,
    totalPerdidosEsteMes: perdidosEsteMes.length,
    totalRechazadosEsteMes: rechazadosEsteMes.length,
    conversionRate,
  };
}

// ===== Entry point =====

export async function buildPromotorDashboard(deps: {
  listOriginations: (filters: { promoterId: number }) => Promise<Origination[]>;
  getTaxista: (id: number) => Promise<any>;
  promoterDbId: number;
  promotorId: string;
}): Promise<PromotorDashboard> {
  const { listOriginations, getTaxista, promoterDbId, promotorId } = deps;

  const p = getPromotorBy({ id: promotorId }) || getPromotorBy({ dbId: promoterDbId });
  const origs = await listOriginations({ promoterId: promoterDbId });

  const folios: DashboardFolio[] = [];
  for (const orig of origs) {
    const taxista = orig.taxistaId ? await getTaxista(orig.taxistaId) : null;
    folios.push(toDashboardFolio(orig, taxista));
  }

  const buckets = groupIntoBuckets(folios);
  const alerts = generarAlertas(folios);
  const kpis = calcularKPIs(folios);

  return {
    promotor: { id: p?.id || promotorId, label: p?.label || "Promotor" },
    timestamp: new Date().toISOString(),
    alerts,
    buckets,
    kpis,
  };
}
