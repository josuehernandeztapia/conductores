import { pgTable, text, integer, serial, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ===== MOTOR CMU (existing) =====

// Vehicle models catalog with CMU and benchmark data
export const models = pgTable("models", {
  id: serial("id").primaryKey(),
  brand: text("brand").notNull(),
  model: text("model").notNull(),
  variant: text("variant"),
  year: integer("year").notNull(),
  cmu: integer("cmu").notNull(),
  purchaseBenchmarkPct: real("purchase_benchmark_pct").notNull(),
  slug: text("slug").notNull(),
  cmuSource: text("cmu_source").notNull().default("catalog"),
  cmuUpdatedAt: text("cmu_updated_at"),
  cmuMin: integer("cmu_min"),
  cmuMax: integer("cmu_max"),
  cmuMedian: integer("cmu_median"),
  cmuSampleCount: integer("cmu_sample_count"),
});

export type Model = typeof models.$inferSelect;

// Saved evaluations (opportunities)
export const opportunities = pgTable("opportunities", {
  id: serial("id").primaryKey(),
  modelId: integer("model_id").notNull(),
  cmuUsed: integer("cmu_used").notNull(),
  insurerPrice: integer("insurer_price").notNull(),
  repairEstimate: integer("repair_estimate").notNull(),
  totalCost: integer("total_cost").notNull(),
  purchasePct: real("purchase_pct").notNull(),
  margin: integer("margin").notNull(),
  tirAnnual: real("tir_annual").notNull(),
  moic: real("moic").notNull(),
  decision: text("decision").notNull(),
  decisionLevel: text("decision_level").notNull(),
  explanation: text("explanation").notNull(),
  city: text("city"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Opportunity = typeof opportunities.$inferSelect;

// Decision thresholds config
export const config = pgTable("config", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull(),
  optimoMarginMin: integer("optimo_margin_min").notNull().default(55000),
  optimoTirMin: real("optimo_tir_min").notNull().default(1.5),
  optimoMoicMin: real("optimo_moic_min").notNull().default(1.8),
  optimoPctMax: real("optimo_pct_max").notNull().default(0.55),
  buenoMarginMin: integer("bueno_margin_min").notNull().default(40000),
  buenoTirMin: real("bueno_tir_min").notNull().default(1.0),
  buenoMoicMin: real("bueno_moic_min").notNull().default(1.5),
  buenoPctMax: real("bueno_pct_max").notNull().default(0.65),
});

export type Config = typeof config.$inferSelect;

// ===== ORIGINACIÓN MODULE =====

// Promotoras (only Ángeles Mireles for now)
export const promoters = pgTable("promoters", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  pin: text("pin").notNull(), // 6-digit PIN
  phone: text("phone"),
  active: integer("active").notNull().default(1), // 1=true, 0=false (SQLite compat)
  createdAt: text("created_at").notNull(),
});

export type Promoter = typeof promoters.$inferSelect;
export const insertPromoterSchema = createInsertSchema(promoters).omit({ id: true });
export type InsertPromoter = z.infer<typeof insertPromoterSchema>;

// Taxistas (driver profiles)
export const taxistas = pgTable("taxistas", {
  id: serial("id").primaryKey(),
  folio: text("folio"), // linked origination folio
  nombre: text("nombre").notNull(),
  apellidoPaterno: text("apellido_paterno").notNull(),
  apellidoMaterno: text("apellido_materno"),
  curp: text("curp"),
  rfc: text("rfc"),
  telefono: text("telefono").notNull(),
  email: text("email"),
  direccion: text("direccion"),
  ciudad: text("ciudad").notNull().default("Aguascalientes"),
  estado: text("estado").notNull().default("Aguascalientes"),
  codigoPostal: text("codigo_postal"),
  perfilTipo: text("perfil_tipo").notNull(), // "A" (GNV) or "B" (gasolina)
  // Profile A fields
  gnvHistorialLeq: integer("gnv_historial_leq"), // monthly LEQ (≥400 for profile A)
  gnvMesesHistorial: integer("gnv_meses_historial"),
  // Profile B fields
  ticketsGasolinaMensual: integer("tickets_gasolina_mensual"), // monthly $ (≥$6,000 for profile B)
  clabe: text("clabe"), // bank account
  banco: text("banco"),
  createdAt: text("created_at").notNull(),
});

export type Taxista = typeof taxistas.$inferSelect;
export const insertTaxistaSchema = createInsertSchema(taxistas).omit({ id: true });
export type InsertTaxista = z.infer<typeof insertTaxistaSchema>;

// Originations (folios) - the main workflow entity
export const originations = pgTable("originations", {
  id: serial("id").primaryKey(),
  folio: text("folio").notNull(), // CMU-VAL-YYMMDD-XXX or CMU-CPV-YYMMDD-XXX
  tipo: text("tipo").notNull(), // "validacion" | "compraventa"
  estado: text("estado").notNull().default("BORRADOR"),
  // States: BORRADOR → CAPTURANDO → VALIDADO → GENERADO → FIRMADO → APROBADO | INCOMPLETO | RECHAZADO
  taxistaId: integer("taxista_id"),
  promoterId: integer("promoter_id").notNull(),
  vehicleInventoryId: integer("vehicle_inventory_id"), // assigned vehicle (compraventa only)
  perfilTipo: text("perfil_tipo").notNull(), // "A" or "B"
  // Step tracking
  currentStep: integer("current_step").notNull().default(1), // 1-7
  // Extracted data (JSON strings for flexibility)
  datosIne: text("datos_ine"), // JSON: {nombre, apellidos, curp, direccion, claveElector, seccion, vigencia}
  datosCsf: text("datos_csf"), // JSON: {rfc, razonSocial, regimenFiscal, domicilioFiscal}
  datosComprobante: text("datos_comprobante"), // JSON: {direccion, tipo, fecha}
  datosConcesion: text("datos_concesion"), // JSON: {numeroConcesion, titular, vigencia, ruta}
  datosEstadoCuenta: text("datos_estado_cuenta"), // JSON: {banco, clabe, titular}
  datosHistorial: text("datos_historial"), // JSON: {tipo, promedioMensual, meses}
  datosFactura: text("datos_factura"), // JSON: {marca, modelo, año, serie, niv, propietario}
  datosMembresia: text("datos_membresia"), // JSON: {numero, titular, vigencia}
  // OTP verification
  otpCode: text("otp_code"), // simulated OTP
  otpVerified: integer("otp_verified").notNull().default(0), // 0=false
  otpPhone: text("otp_phone"),
  // Selfie
  selfieUrl: text("selfie_url"),
  // Vehicle photos (JSON array of URLs)
  vehiclePhotos: text("vehicle_photos"), // JSON array
  // Contract
  contractType: text("contract_type"), // "convenio_validacion" | "contrato_compraventa"
  contractUrl: text("contract_url"),
  contractGeneratedAt: text("contract_generated_at"),
  // Mifiel
  mifielDocumentId: text("mifiel_document_id"),
  mifielStatus: text("mifiel_status"), // "pending" | "signed" | "rejected"
  // Notes
  notes: text("notes"),
  rejectionReason: text("rejection_reason"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type Origination = typeof originations.$inferSelect;
export const insertOriginationSchema = createInsertSchema(originations).omit({ id: true });
export type InsertOrigination = z.infer<typeof insertOriginationSchema>;

// Documents (individual document captures within an origination)
export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  originationId: integer("origination_id").notNull(),
  tipo: text("tipo").notNull(),
  // Types: "ine_frente" | "ine_reverso" | "csf" | "comprobante_domicilio" | "concesion" | 
  //        "estado_cuenta" | "historial_gnv" | "tickets_gasolina" | "factura_vehiculo" | 
  //        "carta_membresia" | "ine_operador_1" | "ine_operador_2" | "selfie_ine" |
  //        "vehiculo_frente" | "vehiculo_lateral_izq" | "vehiculo_lateral_der" | "vehiculo_trasera"
  imageData: text("image_data"), // base64 data URI (for now, would be S3 in production)
  ocrResult: text("ocr_result"), // JSON string with extracted fields
  ocrConfidence: text("ocr_confidence"), // "alta" | "media" | "baja"
  editedData: text("edited_data"), // JSON string if promoter edited OCR results
  status: text("status").notNull().default("pending"), // "pending" | "captured" | "ocr_done" | "verified"
  createdAt: text("created_at").notNull(),
});

export type Document = typeof documents.$inferSelect;
export const insertDocumentSchema = createInsertSchema(documents).omit({ id: true });
export type InsertDocument = z.infer<typeof insertDocumentSchema>;

// Vehicles Inventory (fleet available for assignment)
export const vehiclesInventory = pgTable("vehicles_inventory", {
  id: serial("id").primaryKey(),
  marca: text("marca").notNull(),
  modelo: text("modelo").notNull(),
  variante: text("variante"),
  anio: integer("anio").notNull(),
  color: text("color"),
  niv: text("niv"), // VIN
  placas: text("placas"),
  numSerie: text("num_serie"),
  numMotor: text("num_motor"), // engine number
  cmuValor: integer("cmu_valor"), // CMU market value
  costoAdquisicion: integer("costo_adquisicion"),
  costoReparacion: integer("costo_reparacion"),
  // Status: "disponible" | "asignado" | "en_reparacion" | "vendido" | "baja"
  status: text("status").notNull().default("disponible"),
  assignedOriginationId: integer("assigned_origination_id"),
  assignedTaxistaId: integer("assigned_taxista_id"),
  // Kit GNV (not considered in purchase decision)
  kitGnvInstalado: integer("kit_gnv_instalado").notNull().default(0), // 0=no, 1=yes
  kitGnvCosto: integer("kit_gnv_costo"),
  kitGnvMarca: text("kit_gnv_marca"),
  kitGnvSerie: text("kit_gnv_serie"),
  // Tanque GNV
  tanqueTipo: text("tanque_tipo"), // "reusado" | "nuevo"
  tanqueMarca: text("tanque_marca"),
  tanqueSerie: text("tanque_serie"),
  tanqueCosto: integer("tanque_costo"),
  fotos: text("fotos"), // JSON array of image URLs
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type VehicleInventory = typeof vehiclesInventory.$inferSelect;
export const insertVehicleInventorySchema = createInsertSchema(vehiclesInventory).omit({ id: true });
export type InsertVehicleInventory = z.infer<typeof insertVehicleInventorySchema>;

// Contracts (generated documents)
export const contracts = pgTable("contracts", {
  id: serial("id").primaryKey(),
  originationId: integer("origination_id").notNull(),
  tipo: text("tipo").notNull(), // "convenio_validacion" | "contrato_compraventa"
  folio: text("folio").notNull(),
  // Contract data (JSON with all template fields)
  contractData: text("contract_data").notNull(), // JSON
  // PDF
  pdfUrl: text("pdf_url"),
  pdfGeneratedAt: text("pdf_generated_at"),
  // Signing
  mifielDocumentId: text("mifiel_document_id"),
  signedAt: text("signed_at"),
  signedByTaxista: integer("signed_by_taxista").notNull().default(0),
  signedByPromotora: integer("signed_by_promotora").notNull().default(0),
  signedByCmu: integer("signed_by_cmu").notNull().default(0),
  status: text("status").notNull().default("draft"), // "draft" | "generated" | "sent" | "signed" | "cancelled"
  createdAt: text("created_at").notNull(),
});

export type Contract = typeof contracts.$inferSelect;
export const insertContractSchema = createInsertSchema(contracts).omit({ id: true });
export type InsertContract = z.infer<typeof insertContractSchema>;

// ===== API Types =====

export type EvaluationInput = {
  modelId: number;
  modelSlug: string;
  year: number;
  cmu: number;
  insurerPrice: number;
  repairEstimate: number;
  city?: string;
};

export type CashFlowEntry = {
  month: number;
  balance: number;
  vehiclePayment: number;
  gnvRevenue: number;
  netCashFlow: number;
};

export type SensitivityPoint = {
  repairDelta: number;
  newRepair: number;
  newTotalCost: number;
  newMargin: number;
  newDecision: string;
  newDecisionLevel: string;
};

export type EvaluationResult = {
  model: string;
  brand: string;
  variant: string | null;
  year: number;
  city: string | null;
  cmu: number;
  insurerPrice: number;
  repairEstimate: number;
  totalCost: number;
  purchasePct: number;
  margin: number;
  tirAnnual: number;
  moic: number;
  ventaPlazos: number;
  monthlyPayment: number;
  decision: "COMPRAR" | "DUDOSO" | "NO COMPRAR";
  decisionLevel: "optimo" | "bueno" | "descartar";
  explanation: string;
  totalInflows: number;
  totalOutflows: number;
  cashFlows: CashFlowEntry[];
  sensitivity: SensitivityPoint[];
  purchaseBenchmarkPct: number;
};

export type RepairEstimateRequest = {
  images: string[];
};

export type RepairEstimateResult = {
  severity: "leve" | "medio" | "severo" | "destrucción_total";
  severityLabel: string;
  estimatedRepairMin: number;
  estimatedRepairMax: number;
  estimatedRepairMid: number;
  confidence: "alta" | "media" | "baja";
  details: string;
};

export type ModelOption = {
  id: number;
  brand: string;
  model: string;
  variant: string | null;
  year: number;
  cmu: number;
  slug: string;
  displayName: string;
  cmuSource: string;
  cmuUpdatedAt: string | null;
  cmuMin: number | null;
  cmuMax: number | null;
  cmuMedian: number | null;
  cmuSampleCount: number | null;
};

export type CmuBulkUpdateEntry = {
  slug: string;
  year: number;
  cmu: number;
  cmuMin?: number;
  cmuMax?: number;
  cmuMedian?: number;
  sampleCount?: number;
  source?: string;
};

export type CmuBulkUpdateRequest = {
  entries: CmuBulkUpdateEntry[];
  source: string;
};

// Origination state machine
export type OriginationEstado = 
  | "BORRADOR" 
  | "CAPTURANDO" 
  | "VALIDADO" 
  | "GENERADO" 
  | "FIRMADO" 
  | "APROBADO" 
  | "INCOMPLETO" 
  | "RECHAZADO";

export const ORIGINATION_STEPS = [
  { step: 1, name: "Crear Folio", description: "Tipo de trámite y perfil" },
  { step: 2, name: "Datos Personales", description: "INE + CSF + Comprobante" },
  { step: 3, name: "Documentos Taxi", description: "Concesión + Estado de cuenta + Historial" },
  { step: 4, name: "Documentos Vehículo", description: "Factura + Membresía + INE operadores" },
  { step: 5, name: "Verificación", description: "Selfie con INE + OTP + Fotos vehículo" },
  { step: 6, name: "Contrato", description: "Generación de contrato PDF" },
  { step: 7, name: "Firma", description: "Firma electrónica (Mifiel)" },
] as const;

export const DOCUMENT_TYPES = {
  ine_frente: { label: "INE Frente", step: 2, required: true },
  ine_reverso: { label: "INE Reverso", step: 2, required: true },
  csf: { label: "Constancia de Situación Fiscal", step: 2, required: true },
  comprobante_domicilio: { label: "Comprobante de Domicilio", step: 2, required: true },
  concesion: { label: "Concesión de Taxi", step: 3, required: true },
  estado_cuenta: { label: "Estado de Cuenta Bancario", step: 3, required: true },
  historial_gnv: { label: "Historial GNV", step: 3, required: false }, // only profile A
  tickets_gasolina: { label: "Tickets de Gasolina", step: 3, required: false }, // only profile B
  factura_vehiculo: { label: "Factura del Vehículo", step: 4, required: true },
  carta_membresia: { label: "Carta de Membresía", step: 4, required: true },
  ine_operador_1: { label: "INE Operador 1", step: 4, required: false },
  ine_operador_2: { label: "INE Operador 2", step: 4, required: false },
  selfie_ine: { label: "Selfie con INE", step: 5, required: true },
  vehiculo_frente: { label: "Vehículo - Frente", step: 5, required: true },
  vehiculo_lateral_izq: { label: "Vehículo - Lateral Izq", step: 5, required: true },
  vehiculo_lateral_der: { label: "Vehículo - Lateral Der", step: 5, required: true },
  vehiculo_trasera: { label: "Vehículo - Trasera", step: 5, required: true },
} as const;

export type DocumentType = keyof typeof DOCUMENT_TYPES;
