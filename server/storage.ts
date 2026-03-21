import type { 
  Model, Opportunity, ModelOption, CmuBulkUpdateEntry,
  Promoter, InsertPromoter,
  Taxista, InsertTaxista,
  Origination, InsertOrigination,
  Document, InsertDocument,
  VehicleInventory, InsertVehicleInventory,
  Contract, InsertContract,
} from "@shared/schema";

export interface IStorage {
  // Motor CMU
  getModels(): Promise<Model[]>;
  getModelOptions(): Promise<ModelOption[]>;
  getModelBySlugYear(slug: string, year: number): Promise<Model | undefined>;
  saveOpportunity(opp: Omit<Opportunity, "id" | "createdAt">): Promise<Opportunity>;
  getOpportunities(): Promise<Opportunity[]>;
  updateModelCmu(id: number, cmu: number, source: string, meta?: { cmuMin?: number; cmuMax?: number; cmuMedian?: number; sampleCount?: number }): Promise<Model | undefined>;
  bulkUpdateCmu(entries: CmuBulkUpdateEntry[], source: string): Promise<{ updated: number; notFound: string[] }>;

  // Promoters
  getPromoters(): Promise<Promoter[]>;
  getPromoterByPin(pin: string): Promise<Promoter | undefined>;

  // Taxistas
  createTaxista(data: InsertTaxista): Promise<Taxista>;
  getTaxista(id: number): Promise<Taxista | undefined>;
  updateTaxista(id: number, data: Partial<InsertTaxista>): Promise<Taxista | undefined>;
  listTaxistas(): Promise<Taxista[]>;

  // Originations
  createOrigination(data: InsertOrigination): Promise<Origination>;
  getOrigination(id: number): Promise<Origination | undefined>;
  getOriginationByFolio(folio: string): Promise<Origination | undefined>;
  updateOrigination(id: number, data: Partial<InsertOrigination>): Promise<Origination | undefined>;
  listOriginations(filters?: { estado?: string; promoterId?: number }): Promise<Origination[]>;
  getNextFolioSequence(prefix: string, dateStr: string): Promise<number>;

  // Documents
  createDocument(data: InsertDocument): Promise<Document>;
  getDocument(id: number): Promise<Document | undefined>;
  updateDocument(id: number, data: Partial<InsertDocument>): Promise<Document | undefined>;
  getDocumentsByOrigination(originationId: number): Promise<Document[]>;
  getDocumentByOriginationAndType(originationId: number, tipo: string): Promise<Document | undefined>;

  // Vehicles Inventory
  createVehicle(data: InsertVehicleInventory): Promise<VehicleInventory>;
  getVehicle(id: number): Promise<VehicleInventory | undefined>;
  updateVehicle(id: number, data: Partial<InsertVehicleInventory>): Promise<VehicleInventory | undefined>;
  listVehicles(filters?: { status?: string }): Promise<VehicleInventory[]>;
  getAvailableVehicles(): Promise<VehicleInventory[]>;

  // Contracts
  createContract(data: InsertContract): Promise<Contract>;
  getContract(id: number): Promise<Contract | undefined>;
  updateContract(id: number, data: Partial<InsertContract>): Promise<Contract | undefined>;
  getContractByOrigination(originationId: number): Promise<Contract | undefined>;
}

export class MemStorage implements IStorage {
  private models: Map<number, Model>;
  private opportunities: Map<number, Opportunity>;
  private promotersMap: Map<number, Promoter>;
  private taxistasMap: Map<number, Taxista>;
  private originationsMap: Map<number, Origination>;
  private documentsMap: Map<number, Document>;
  private vehiclesMap: Map<number, VehicleInventory>;
  private contractsMap: Map<number, Contract>;

  private modelSeq = 1;
  private oppSeq = 1;
  private promoterSeq = 1;
  private taxistaSeq = 1;
  private originationSeq = 1;
  private documentSeq = 1;
  private vehicleSeq = 1;
  private contractSeq = 1;

  constructor() {
    this.models = new Map();
    this.opportunities = new Map();
    this.promotersMap = new Map();
    this.taxistasMap = new Map();
    this.originationsMap = new Map();
    this.documentsMap = new Map();
    this.vehiclesMap = new Map();
    this.contractsMap = new Map();
    this.seedModels();
    this.seedPromoters();
    this.seedVehicles();
  }

  private seedModels() {
    const seedDate = "2026-03-19T00:00:00Z";
    const seed: Array<{
      brand: string; model: string; variant: string | null; slug: string;
      year: number; cmu: number; benchmarkPct: number;
    }> = [
      { brand: "Chevrolet", model: "Aveo", variant: null, slug: "aveo", year: 2021, cmu: 191000, benchmarkPct: 0.53 },
      { brand: "Chevrolet", model: "Aveo", variant: null, slug: "aveo", year: 2022, cmu: 200000, benchmarkPct: 0.53 },
      { brand: "Chevrolet", model: "Aveo", variant: null, slug: "aveo", year: 2023, cmu: 205000, benchmarkPct: 0.53 },
      { brand: "Chevrolet", model: "Aveo", variant: null, slug: "aveo", year: 2024, cmu: 246000, benchmarkPct: 0.53 },
      { brand: "Nissan", model: "March", variant: "Sense", slug: "march", year: 2021, cmu: 195000, benchmarkPct: 0.60 },
      { brand: "Nissan", model: "March", variant: "Sense", slug: "march", year: 2022, cmu: 200000, benchmarkPct: 0.60 },
      { brand: "Nissan", model: "March", variant: "Sense", slug: "march", year: 2023, cmu: 245000, benchmarkPct: 0.60 },
      { brand: "Nissan", model: "March", variant: "Sense", slug: "march", year: 2024, cmu: 242000, benchmarkPct: 0.60 },
      { brand: "Nissan", model: "March", variant: "Advance", slug: "march", year: 2021, cmu: 224000, benchmarkPct: 0.60 },
      { brand: "Nissan", model: "March", variant: "Advance", slug: "march", year: 2022, cmu: 244000, benchmarkPct: 0.60 },
      { brand: "Nissan", model: "March", variant: "Advance", slug: "march", year: 2023, cmu: 246000, benchmarkPct: 0.60 },
      { brand: "Nissan", model: "March", variant: "Advance", slug: "march", year: 2024, cmu: 265000, benchmarkPct: 0.60 },
      { brand: "Nissan", model: "V-Drive", variant: null, slug: "v-drive", year: 2021, cmu: 225000, benchmarkPct: 0.60 },
      { brand: "Nissan", model: "V-Drive", variant: null, slug: "v-drive", year: 2022, cmu: 221000, benchmarkPct: 0.60 },
      { brand: "Nissan", model: "V-Drive", variant: null, slug: "v-drive", year: 2023, cmu: 255000, benchmarkPct: 0.60 },
      { brand: "Nissan", model: "V-Drive", variant: null, slug: "v-drive", year: 2024, cmu: 260000, benchmarkPct: 0.60 },
      { brand: "Nissan", model: "V-Drive", variant: null, slug: "v-drive", year: 2025, cmu: 268000, benchmarkPct: 0.60 },
    ];

    for (const s of seed) {
      const id = this.modelSeq++;
      this.models.set(id, {
        id, brand: s.brand, model: s.model, variant: s.variant, year: s.year,
        cmu: s.cmu, purchaseBenchmarkPct: s.benchmarkPct, slug: s.slug,
        cmuSource: "catalog", cmuUpdatedAt: seedDate,
        cmuMin: null, cmuMax: null, cmuMedian: null, cmuSampleCount: null,
      });
    }
  }

  private seedPromoters() {
    const id = this.promoterSeq++;
    this.promotersMap.set(id, {
      id,
      name: "Ángeles Mireles",
      pin: "123456",
      phone: "+524491234567",
      active: 1,
      createdAt: new Date().toISOString(),
    });
  }

  private seedVehicles() {
    const now = new Date().toISOString();
    const seedVehicles: Array<Omit<VehicleInventory, "id">> = [
      { marca: "Nissan", modelo: "March", variante: "Sense", anio: 2022, color: "Blanco", niv: "3N1CK3CD5NL000001", placas: "AGS-1234", numSerie: "NL000001", numMotor: "HR12DE-001234", cmuValor: 200000, costoAdquisicion: 120000, costoReparacion: 15000, status: "disponible", assignedOriginationId: null, assignedTaxistaId: null, kitGnvInstalado: 1, kitGnvCosto: 18000, kitGnvMarca: "LOVATO", kitGnvSerie: "LVT-2024-0001", tanqueTipo: "nuevo", tanqueMarca: "CILBRAS", tanqueSerie: "CIL-60L-0001", tanqueCosto: 12000, fotos: null, notes: null, createdAt: now, updatedAt: now },
      { marca: "Chevrolet", modelo: "Aveo", variante: null, anio: 2023, color: "Gris", niv: "3G1TC5CF3PL000002", placas: "AGS-5678", numSerie: "PL000002", numMotor: "B12D1-005678", cmuValor: 205000, costoAdquisicion: 108000, costoReparacion: 10000, status: "disponible", assignedOriginationId: null, assignedTaxistaId: null, kitGnvInstalado: 0, kitGnvCosto: null, kitGnvMarca: null, kitGnvSerie: null, tanqueTipo: null, tanqueMarca: null, tanqueSerie: null, tanqueCosto: null, fotos: null, notes: "Pendiente instalación kit GNV", createdAt: now, updatedAt: now },
      { marca: "Nissan", modelo: "V-Drive", variante: null, anio: 2022, color: "Rojo", niv: "3N1CK3CD7NL000003", placas: "AGS-9012", numSerie: "NL000003", numMotor: "HR16DE-009012", cmuValor: 221000, costoAdquisicion: 132000, costoReparacion: 8000, status: "en_reparacion", assignedOriginationId: null, assignedTaxistaId: null, kitGnvInstalado: 1, kitGnvCosto: 18000, kitGnvMarca: "TOMASETTO", kitGnvSerie: "TMS-2024-0003", tanqueTipo: "reusado", tanqueMarca: "CILBRAS", tanqueSerie: "CIL-60L-R003", tanqueCosto: 8000, fotos: null, notes: "En taller, estimado 1 semana", createdAt: now, updatedAt: now },
      { marca: "Nissan", modelo: "March", variante: "Advance", anio: 2021, color: "Azul", niv: "3N1CK3CD1ML000004", placas: "AGS-3456", numSerie: "ML000004", numMotor: "HR12DE-003456", cmuValor: 224000, costoAdquisicion: 134000, costoReparacion: 12000, status: "asignado", assignedOriginationId: null, assignedTaxistaId: null, kitGnvInstalado: 1, kitGnvCosto: 18000, kitGnvMarca: "LOVATO", kitGnvSerie: "LVT-2024-0004", tanqueTipo: "nuevo", tanqueMarca: "WORTHINGTON", tanqueSerie: "WTH-60L-0004", tanqueCosto: 12000, fotos: null, notes: null, createdAt: now, updatedAt: now },
    ];

    for (const v of seedVehicles) {
      const id = this.vehicleSeq++;
      this.vehiclesMap.set(id, { id, ...v });
    }
  }

  // ===== Motor CMU =====
  async getModels(): Promise<Model[]> {
    return Array.from(this.models.values());
  }

  async getModelOptions(): Promise<ModelOption[]> {
    return Array.from(this.models.values()).map((m) => ({
      id: m.id, brand: m.brand, model: m.model, variant: m.variant,
      year: m.year, cmu: m.cmu, slug: m.slug,
      displayName: m.variant ? `${m.model} ${m.variant}` : m.model,
      cmuSource: m.cmuSource, cmuUpdatedAt: m.cmuUpdatedAt,
      cmuMin: m.cmuMin, cmuMax: m.cmuMax, cmuMedian: m.cmuMedian, cmuSampleCount: m.cmuSampleCount,
    }));
  }

  async getModelBySlugYear(slug: string, year: number): Promise<Model | undefined> {
    return Array.from(this.models.values()).find((m) => m.slug === slug && m.year === year);
  }

  async saveOpportunity(opp: Omit<Opportunity, "id" | "createdAt">): Promise<Opportunity> {
    const id = this.oppSeq++;
    const full: Opportunity = { ...opp, id, createdAt: new Date() };
    this.opportunities.set(id, full);
    return full;
  }

  async getOpportunities(): Promise<Opportunity[]> {
    return Array.from(this.opportunities.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async updateModelCmu(
    id: number, cmu: number, source: string,
    meta?: { cmuMin?: number; cmuMax?: number; cmuMedian?: number; sampleCount?: number }
  ): Promise<Model | undefined> {
    const model = this.models.get(id);
    if (!model) return undefined;
    model.cmu = cmu;
    model.cmuSource = source;
    model.cmuUpdatedAt = new Date().toISOString();
    if (meta) {
      if (meta.cmuMin !== undefined) model.cmuMin = meta.cmuMin;
      if (meta.cmuMax !== undefined) model.cmuMax = meta.cmuMax;
      if (meta.cmuMedian !== undefined) model.cmuMedian = meta.cmuMedian;
      if (meta.sampleCount !== undefined) model.cmuSampleCount = meta.sampleCount;
    }
    return model;
  }

  async bulkUpdateCmu(entries: CmuBulkUpdateEntry[], source: string): Promise<{ updated: number; notFound: string[] }> {
    let updated = 0;
    const notFound: string[] = [];
    const allModels = Array.from(this.models.values());
    for (const entry of entries) {
      const matches = allModels.filter((m) => m.slug === entry.slug && m.year === entry.year);
      if (matches.length === 0) { notFound.push(`${entry.slug}-${entry.year}`); continue; }
      for (const model of matches) {
        model.cmu = entry.cmu;
        model.cmuSource = entry.source || source;
        model.cmuUpdatedAt = new Date().toISOString();
        if (entry.cmuMin !== undefined) model.cmuMin = entry.cmuMin;
        if (entry.cmuMax !== undefined) model.cmuMax = entry.cmuMax;
        if (entry.cmuMedian !== undefined) model.cmuMedian = entry.cmuMedian;
        if (entry.sampleCount !== undefined) model.cmuSampleCount = entry.sampleCount;
        updated++;
      }
    }
    return { updated, notFound };
  }

  // ===== Promoters =====
  async getPromoters(): Promise<Promoter[]> {
    return Array.from(this.promotersMap.values());
  }

  async getPromoterByPin(pin: string): Promise<Promoter | undefined> {
    return Array.from(this.promotersMap.values()).find((p) => p.pin === pin && p.active === 1);
  }

  // ===== Taxistas =====
  async createTaxista(data: InsertTaxista): Promise<Taxista> {
    const id = this.taxistaSeq++;
    const taxista: Taxista = { ...data, id };
    this.taxistasMap.set(id, taxista);
    return taxista;
  }

  async getTaxista(id: number): Promise<Taxista | undefined> {
    return this.taxistasMap.get(id);
  }

  async updateTaxista(id: number, data: Partial<InsertTaxista>): Promise<Taxista | undefined> {
    const taxista = this.taxistasMap.get(id);
    if (!taxista) return undefined;
    Object.assign(taxista, data);
    return taxista;
  }

  async listTaxistas(): Promise<Taxista[]> {
    return Array.from(this.taxistasMap.values());
  }

  // ===== Originations =====
  async createOrigination(data: InsertOrigination): Promise<Origination> {
    const id = this.originationSeq++;
    const orig: Origination = { ...data, id };
    this.originationsMap.set(id, orig);
    return orig;
  }

  async getOrigination(id: number): Promise<Origination | undefined> {
    return this.originationsMap.get(id);
  }

  async getOriginationByFolio(folio: string): Promise<Origination | undefined> {
    return Array.from(this.originationsMap.values()).find((o) => o.folio === folio);
  }

  async updateOrigination(id: number, data: Partial<InsertOrigination>): Promise<Origination | undefined> {
    const orig = this.originationsMap.get(id);
    if (!orig) return undefined;
    Object.assign(orig, data, { updatedAt: new Date().toISOString() });
    return orig;
  }

  async listOriginations(filters?: { estado?: string; promoterId?: number }): Promise<Origination[]> {
    let list = Array.from(this.originationsMap.values());
    if (filters?.estado) list = list.filter((o) => o.estado === filters.estado);
    if (filters?.promoterId) list = list.filter((o) => o.promoterId === filters.promoterId);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getNextFolioSequence(prefix: string, dateStr: string): Promise<number> {
    const pattern = `${prefix}-${dateStr}-`;
    const existing = Array.from(this.originationsMap.values())
      .filter((o) => o.folio.startsWith(pattern));
    return existing.length + 1;
  }

  // ===== Documents =====
  async createDocument(data: InsertDocument): Promise<Document> {
    const id = this.documentSeq++;
    const doc: Document = { ...data, id };
    this.documentsMap.set(id, doc);
    return doc;
  }

  async getDocument(id: number): Promise<Document | undefined> {
    return this.documentsMap.get(id);
  }

  async updateDocument(id: number, data: Partial<InsertDocument>): Promise<Document | undefined> {
    const doc = this.documentsMap.get(id);
    if (!doc) return undefined;
    Object.assign(doc, data);
    return doc;
  }

  async getDocumentsByOrigination(originationId: number): Promise<Document[]> {
    return Array.from(this.documentsMap.values())
      .filter((d) => d.originationId === originationId);
  }

  async getDocumentByOriginationAndType(originationId: number, tipo: string): Promise<Document | undefined> {
    return Array.from(this.documentsMap.values())
      .find((d) => d.originationId === originationId && d.tipo === tipo);
  }

  // ===== Vehicles Inventory =====
  async createVehicle(data: InsertVehicleInventory): Promise<VehicleInventory> {
    const id = this.vehicleSeq++;
    const vehicle: VehicleInventory = { ...data, id };
    this.vehiclesMap.set(id, vehicle);
    return vehicle;
  }

  async getVehicle(id: number): Promise<VehicleInventory | undefined> {
    return this.vehiclesMap.get(id);
  }

  async updateVehicle(id: number, data: Partial<InsertVehicleInventory>): Promise<VehicleInventory | undefined> {
    const vehicle = this.vehiclesMap.get(id);
    if (!vehicle) return undefined;
    Object.assign(vehicle, data, { updatedAt: new Date().toISOString() });
    return vehicle;
  }

  async listVehicles(filters?: { status?: string }): Promise<VehicleInventory[]> {
    let list = Array.from(this.vehiclesMap.values());
    if (filters?.status) list = list.filter((v) => v.status === filters.status);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getAvailableVehicles(): Promise<VehicleInventory[]> {
    return Array.from(this.vehiclesMap.values())
      .filter((v) => v.status === "disponible");
  }

  // ===== Contracts =====
  async createContract(data: InsertContract): Promise<Contract> {
    const id = this.contractSeq++;
    const contract: Contract = { ...data, id };
    this.contractsMap.set(id, contract);
    return contract;
  }

  async getContract(id: number): Promise<Contract | undefined> {
    return this.contractsMap.get(id);
  }

  async updateContract(id: number, data: Partial<InsertContract>): Promise<Contract | undefined> {
    const contract = this.contractsMap.get(id);
    if (!contract) return undefined;
    Object.assign(contract, data);
    return contract;
  }

  async getContractByOrigination(originationId: number): Promise<Contract | undefined> {
    return Array.from(this.contractsMap.values())
      .find((c) => c.originationId === originationId);
  }
}

// ===== Neon PostgreSQL Storage =====
import { neon } from "@neondatabase/serverless";

class NeonStorage implements IStorage {
  private sql: ReturnType<typeof neon>;

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
    console.log("[NeonStorage] Connected to Neon PostgreSQL");
  }

  async getModels(): Promise<Model[]> {
    return this.sql`SELECT * FROM models ORDER BY brand, model, variant, year` as any;
  }
  async getModelOptions(): Promise<ModelOption[]> {
    const rows = await this.sql`SELECT * FROM models ORDER BY brand, model, variant, year`;
    return rows.map((r: any) => ({
      id: r.id, brand: r.brand, model: r.model, variant: r.variant, year: r.year,
      cmu: r.cmu, slug: r.slug,
      displayName: r.variant ? `${r.model} ${r.variant}` : r.model,
      cmuSource: r.cmu_source, cmuUpdatedAt: r.cmu_updated_at,
      cmuMin: r.cmu_min, cmuMax: r.cmu_max, cmuMedian: r.cmu_median, cmuSampleCount: r.cmu_sample_count,
    }));
  }
  async getModelBySlugYear(slug: string, year: number) {
    const rows = await this.sql`SELECT * FROM models WHERE slug = ${slug} AND year = ${year} LIMIT 1`;
    return rows[0] as Model | undefined;
  }
  async saveOpportunity(opp: Omit<Opportunity, "id" | "createdAt">) {
    const now = new Date().toISOString();
    const rows = await this.sql`INSERT INTO opportunities (model_id, model_slug, year, cmu_used, insurer_price, repair_estimate, total_cost, purchase_pct, margin, tir_annual, moic, decision, decision_level, explanation, city, created_at) VALUES (${(opp as any).modelId}, ${(opp as any).modelSlug}, ${(opp as any).year}, ${(opp as any).cmuUsed}, ${(opp as any).insurerPrice}, ${(opp as any).repairEstimate}, ${(opp as any).totalCost}, ${(opp as any).purchasePct}, ${(opp as any).margin}, ${(opp as any).tirAnnual}, ${(opp as any).moic}, ${(opp as any).decision}, ${(opp as any).decisionLevel}, ${(opp as any).explanation}, ${(opp as any).city}, ${now}) RETURNING *`;
    return rows[0] as Opportunity;
  }
  async getOpportunities() {
    return this.sql`SELECT * FROM opportunities ORDER BY created_at DESC` as any;
  }
  async updateModelCmu(id: number, cmu: number, source: string, meta?: any) {
    const now = new Date().toISOString();
    const rows = await this.sql`UPDATE models SET cmu = ${cmu}, cmu_source = ${source}, cmu_updated_at = ${now}, cmu_min = ${meta?.cmuMin ?? null}, cmu_max = ${meta?.cmuMax ?? null}, cmu_median = ${meta?.cmuMedian ?? null}, cmu_sample_count = ${meta?.sampleCount ?? null} WHERE id = ${id} RETURNING *`;
    return rows[0] as Model | undefined;
  }
  async bulkUpdateCmu(entries: CmuBulkUpdateEntry[], source: string) {
    let updated = 0; const notFound: string[] = [];
    for (const e of entries) {
      const rows = await this.sql`UPDATE models SET cmu = ${e.cmu}, cmu_source = ${source}, cmu_updated_at = ${new Date().toISOString()} WHERE slug = ${e.slug} AND year = ${e.year} RETURNING id`;
      if (rows.length > 0) updated++; else notFound.push(`${e.slug}-${e.year}`);
    }
    return { updated, notFound };
  }
  async getPromoters() { return this.sql`SELECT * FROM promoters` as any; }
  async getPromoterByPin(pin: string) {
    const rows = await this.sql`SELECT * FROM promoters WHERE pin = ${pin} AND active = 1 LIMIT 1`;
    return rows[0] as Promoter | undefined;
  }
  async createTaxista(data: InsertTaxista) {
    const rows = await this.sql`INSERT INTO taxistas (folio, nombre, apellido_paterno, apellido_materno, curp, rfc, telefono, email, direccion, ciudad, estado, codigo_postal, perfil_tipo, gnv_historial_leq, gnv_meses_historial, tickets_gasolina_mensual, clabe, banco, created_at) VALUES (${data.folio}, ${data.nombre}, ${data.apellidoPaterno}, ${data.apellidoMaterno}, ${data.curp}, ${data.rfc}, ${data.telefono}, ${data.email}, ${data.direccion}, ${data.ciudad}, ${data.estado}, ${data.codigoPostal}, ${data.perfilTipo}, ${data.gnvHistorialLeq}, ${data.gnvMesesHistorial}, ${data.ticketsGasolinaMensual}, ${data.clabe}, ${data.banco}, ${data.createdAt}) RETURNING *`;
    return rows[0] as Taxista;
  }
  async getTaxista(id: number) {
    const rows = await this.sql`SELECT * FROM taxistas WHERE id = ${id} LIMIT 1`;
    return rows[0] as Taxista | undefined;
  }
  async updateTaxista(id: number, data: Partial<InsertTaxista>) {
    // Simple approach: fetch, merge, update all fields
    const existing = await this.getTaxista(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data };
    const rows = await this.sql`UPDATE taxistas SET nombre = ${merged.nombre}, apellido_paterno = ${(merged as any).apellidoPaterno ?? (merged as any).apellido_paterno}, telefono = ${merged.telefono}, curp = ${merged.curp}, rfc = ${merged.rfc} WHERE id = ${id} RETURNING *`;
    return rows[0] as Taxista | undefined;
  }
  async listTaxistas() { return this.sql`SELECT * FROM taxistas ORDER BY id DESC` as any; }
  async createOrigination(data: InsertOrigination) {
    const rows = await this.sql`INSERT INTO originations (folio, tipo, estado, taxista_id, promoter_id, vehicle_inventory_id, perfil_tipo, current_step, otp_phone, created_at, updated_at) VALUES (${data.folio}, ${data.tipo}, ${data.estado || 'BORRADOR'}, ${data.taxistaId}, ${data.promoterId}, ${data.vehicleInventoryId}, ${data.perfilTipo}, ${data.currentStep || 1}, ${data.otpPhone}, ${data.createdAt}, ${data.updatedAt}) RETURNING *`;
    return rows[0] as Origination;
  }
  async getOrigination(id: number) {
    const rows = await this.sql`SELECT * FROM originations WHERE id = ${id} LIMIT 1`;
    return rows[0] as Origination | undefined;
  }
  async getOriginationByFolio(folio: string) {
    const rows = await this.sql`SELECT * FROM originations WHERE folio = ${folio} LIMIT 1`;
    return rows[0] as Origination | undefined;
  }
  async updateOrigination(id: number, data: Partial<InsertOrigination>) {
    const now = new Date().toISOString();
    // Build dynamic SET clause
    const existing = await this.getOrigination(id);
    if (!existing) return undefined;
    const merged: any = { ...existing, ...data, updated_at: now };
    const rows = await this.sql`UPDATE originations SET estado = ${merged.estado ?? merged.estado}, current_step = ${merged.currentStep ?? merged.current_step ?? existing.currentStep}, otp_code = ${merged.otpCode ?? merged.otp_code ?? null}, otp_verified = ${merged.otpVerified ?? merged.otp_verified ?? 0}, otp_phone = ${merged.otpPhone ?? merged.otp_phone ?? null}, datos_ine = ${merged.datosIne ?? merged.datos_ine ?? null}, datos_csf = ${merged.datosCsf ?? merged.datos_csf ?? null}, datos_comprobante = ${merged.datosComprobante ?? merged.datos_comprobante ?? null}, datos_concesion = ${merged.datosConcesion ?? merged.datos_concesion ?? null}, datos_estado_cuenta = ${merged.datosEstadoCuenta ?? merged.datos_estado_cuenta ?? null}, datos_historial = ${merged.datosHistorial ?? merged.datos_historial ?? null}, datos_factura = ${merged.datosFactura ?? merged.datos_factura ?? null}, datos_membresia = ${merged.datosMembresia ?? merged.datos_membresia ?? null}, vehicle_inventory_id = ${merged.vehicleInventoryId ?? merged.vehicle_inventory_id ?? null}, contract_type = ${merged.contractType ?? merged.contract_type ?? null}, contract_url = ${merged.contractUrl ?? merged.contract_url ?? null}, contract_generated_at = ${merged.contractGeneratedAt ?? merged.contract_generated_at ?? null}, mifiel_document_id = ${merged.mifielDocumentId ?? merged.mifiel_document_id ?? null}, mifiel_status = ${merged.mifielStatus ?? merged.mifiel_status ?? null}, selfie_url = ${merged.selfieUrl ?? merged.selfie_url ?? null}, vehicle_photos = ${merged.vehiclePhotos ?? merged.vehicle_photos ?? null}, notes = ${merged.notes ?? null}, rejection_reason = ${merged.rejectionReason ?? merged.rejection_reason ?? null}, updated_at = ${now} WHERE id = ${id} RETURNING *`;
    return rows[0] as Origination | undefined;
  }
  async listOriginations(filters?: { estado?: string; promoterId?: number }) {
    if (filters?.estado) {
      return this.sql`SELECT * FROM originations WHERE estado = ${filters.estado} ORDER BY created_at DESC` as any;
    }
    return this.sql`SELECT * FROM originations ORDER BY created_at DESC` as any;
  }
  async getNextFolioSequence(prefix: string, dateStr: string) {
    const pattern = `${prefix}-${dateStr}-%`;
    const rows = await this.sql`SELECT COUNT(*) as c FROM originations WHERE folio LIKE ${pattern}`;
    return (parseInt(rows[0]?.c) || 0) + 1;
  }
  async createDocument(data: InsertDocument) {
    const rows = await this.sql`INSERT INTO documents (origination_id, tipo, image_data, ocr_result, ocr_confidence, edited_data, status, created_at) VALUES (${data.originationId}, ${data.tipo}, ${data.imageData}, ${data.ocrResult}, ${data.ocrConfidence}, ${data.editedData}, ${data.status || 'pending'}, ${data.createdAt}) RETURNING *`;
    return rows[0] as Document;
  }
  async getDocument(id: number) {
    const rows = await this.sql`SELECT * FROM documents WHERE id = ${id} LIMIT 1`;
    return rows[0] as Document | undefined;
  }
  async updateDocument(id: number, data: Partial<InsertDocument>) {
    const existing = await this.getDocument(id);
    if (!existing) return undefined;
    const m: any = { ...existing, ...data };
    const rows = await this.sql`UPDATE documents SET image_data = ${m.imageData ?? m.image_data ?? null}, ocr_result = ${m.ocrResult ?? m.ocr_result ?? null}, ocr_confidence = ${m.ocrConfidence ?? m.ocr_confidence ?? null}, edited_data = ${m.editedData ?? m.edited_data ?? null}, status = ${m.status ?? 'pending'} WHERE id = ${id} RETURNING *`;
    return rows[0] as Document | undefined;
  }
  async getDocumentsByOrigination(originationId: number) {
    return this.sql`SELECT * FROM documents WHERE origination_id = ${originationId} ORDER BY id` as any;
  }
  async getDocumentByOriginationAndType(originationId: number, tipo: string) {
    const rows = await this.sql`SELECT * FROM documents WHERE origination_id = ${originationId} AND tipo = ${tipo} LIMIT 1`;
    return rows[0] as Document | undefined;
  }
  async createVehicle(data: InsertVehicleInventory) {
    const now = new Date().toISOString();
    const rows = await this.sql`INSERT INTO vehicles_inventory (marca, modelo, variante, anio, color, niv, placas, num_serie, num_motor, cmu_valor, costo_adquisicion, costo_reparacion, status, kit_gnv_instalado, kit_gnv_costo, kit_gnv_marca, kit_gnv_serie, tanque_tipo, tanque_marca, tanque_serie, tanque_costo, notes, created_at, updated_at) VALUES (${data.marca}, ${data.modelo}, ${data.variante}, ${data.anio}, ${data.color}, ${data.niv}, ${data.placas}, ${data.numSerie}, ${data.numMotor}, ${data.cmuValor}, ${data.costoAdquisicion}, ${data.costoReparacion}, ${data.status || 'disponible'}, ${data.kitGnvInstalado || 0}, ${data.kitGnvCosto}, ${data.kitGnvMarca}, ${data.kitGnvSerie}, ${data.tanqueTipo}, ${data.tanqueMarca}, ${data.tanqueSerie}, ${data.tanqueCosto}, ${data.notes}, ${now}, ${now}) RETURNING *`;
    return rows[0] as VehicleInventory;
  }
  async getVehicle(id: number) {
    const rows = await this.sql`SELECT * FROM vehicles_inventory WHERE id = ${id} LIMIT 1`;
    return rows[0] as VehicleInventory | undefined;
  }
  async updateVehicle(id: number, data: Partial<InsertVehicleInventory>) {
    const existing = await this.getVehicle(id);
    if (!existing) return undefined;
    const m: any = { ...existing, ...data, updated_at: new Date().toISOString() };
    const rows = await this.sql`UPDATE vehicles_inventory SET marca = ${m.marca}, modelo = ${m.modelo}, anio = ${m.anio}, color = ${m.color}, status = ${m.status}, notes = ${m.notes}, updated_at = ${m.updated_at} WHERE id = ${id} RETURNING *`;
    return rows[0] as VehicleInventory | undefined;
  }
  async listVehicles(filters?: { status?: string }) {
    if (filters?.status) {
      return this.sql`SELECT * FROM vehicles_inventory WHERE status = ${filters.status} ORDER BY created_at DESC` as any;
    }
    return this.sql`SELECT * FROM vehicles_inventory ORDER BY created_at DESC` as any;
  }
  async createContract(data: InsertContract) {
    const rows = await this.sql`INSERT INTO contracts (origination_id, tipo, folio, contract_data, status, created_at) VALUES (${data.originationId}, ${data.tipo}, ${data.folio}, ${data.contractData}, ${data.status || 'draft'}, ${data.createdAt}) RETURNING *`;
    return rows[0] as Contract;
  }
  async getContractByOrigination(originationId: number) {
    const rows = await this.sql`SELECT * FROM contracts WHERE origination_id = ${originationId} LIMIT 1`;
    return rows[0] as Contract | undefined;
  }
}

// ===== Export: Use Neon if DATABASE_URL is set, otherwise MemStorage =====
const DATABASE_URL = process.env.DATABASE_URL;
export const storage: IStorage = DATABASE_URL
  ? new NeonStorage(DATABASE_URL)
  : new MemStorage();
