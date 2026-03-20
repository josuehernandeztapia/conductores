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

export const storage = new MemStorage();
