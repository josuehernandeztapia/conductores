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
  createModel(data: any): Promise<Model>;
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
  findFolioFlexible(query: string): Promise<{ origination: Origination; taxistaName: string | null; matchType: string }[]>;

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
  deleteVehicle(id: number): Promise<void>;
  listVehicles(filters?: { status?: string }): Promise<VehicleInventory[]>;
  getAvailableVehicles(): Promise<VehicleInventory[]>;

  // Contracts
  createContract(data: InsertContract): Promise<Contract>;
  getContract(id: number): Promise<Contract | undefined>;
  updateContract(id: number, data: Partial<InsertContract>): Promise<Contract | undefined>;
  getContractByOrigination(originationId: number): Promise<Contract | undefined>;

  // WhatsApp Roles
  getRoleByPhone(phone: string): Promise<{ phone: string; role: string; name: string | null; permissions: string[]; folio_id: number | null; phone_verified: boolean; active: boolean } | null>;
  createRole(phone: string, role: string, name: string | null, permissions?: string[]): Promise<any>;
  updateRole(phone: string, updates: Record<string, any>): Promise<any>;
  verifyPhone(phone: string): Promise<void>;

  // WhatsApp OTP
  createOTP(phone: string, code: string, expiresAt: Date): Promise<void>;
  verifyOTP(phone: string, code: string): Promise<{ valid: boolean; expired?: boolean; maxAttempts?: boolean }>;

  // Model lookup for Motor CMU (dynamic)
  findModelFuzzy(query: string): Promise<Model | undefined>;

  // Fuel prices
  getFuelPrices(): Promise<{ gnv: number; magna: number; premium: number }>;

  // Client state lookup by phone
  getClientStateByPhone(phone: string): Promise<{
    found: boolean;
    originationId: number | null;
    folio: string | null;
    estado: string | null;
    taxistaName: string | null;
    taxistaId: number | null;
    perfilTipo: string | null;
    currentStep: number | null;
    docsCapturados: string[];
    docsPendientes: string[];
    totalDocs: number;
  } | null>;
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
  async createModel(data: any): Promise<Model> {
    const id = this.models.size + 1000;
    const m = { ...data, id } as Model;
    this.models.set(id, m);
    return m;
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

  async findFolioFlexible(query: string): Promise<{ origination: Origination; taxistaName: string | null; matchType: string }[]> {
    const q = query.toLowerCase().trim();
    const results: { origination: Origination; taxistaName: string | null; matchType: string }[] = [];
    const origs = Array.from(this.originationsMap.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    
    // "el último" / "el más reciente"
    if (q.includes("último") || q.includes("ultimo") || q.includes("reciente") || q.includes("nueva")) {
      if (origs.length > 0) {
        const o = origs[0];
        const tid = (o as any).taxistaId || (o as any).taxista_id;
        let name: string | null = null;
        if (tid) { const t = await this.getTaxista(tid); if (t) name = `${(t as any).nombre} ${(t as any).apellidoPaterno || (t as any).apellido_paterno || ""}`; }
        results.push({ origination: o, taxistaName: name, matchType: "más_reciente" });
      }
      return results;
    }

    for (const o of origs) {
      // Match partial folio (e.g. "047", "260320-001")
      if (o.folio.toLowerCase().includes(q)) {
        const tid = (o as any).taxistaId || (o as any).taxista_id;
        let name: string | null = null;
        if (tid) { const t = await this.getTaxista(tid); if (t) name = `${(t as any).nombre} ${(t as any).apellidoPaterno || (t as any).apellido_paterno || ""}`; }
        results.push({ origination: o, taxistaName: name, matchType: "folio_parcial" });
        continue;
      }
      // Match by taxista name
      const tid = (o as any).taxistaId || (o as any).taxista_id;
      if (tid) {
        const t = await this.getTaxista(tid);
        if (t) {
          const fullName = `${(t as any).nombre} ${(t as any).apellidoPaterno || (t as any).apellido_paterno || ""} ${(t as any).apellidoMaterno || (t as any).apellido_materno || ""}`.toLowerCase();
          if (fullName.includes(q)) {
            results.push({ origination: o, taxistaName: `${(t as any).nombre} ${(t as any).apellidoPaterno || (t as any).apellido_paterno || ""}`, matchType: "nombre" });
          }
        }
      }
    }
    return results.slice(0, 5);
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

  async deleteVehicle(id: number): Promise<void> {
    this.vehiclesMap.delete(id);
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

  // WhatsApp Roles (MemStorage stubs)
  async getRoleByPhone(_phone: string) { return null; }
  async createRole(_phone: string, _role: string, _name: string | null, _perms?: string[]) { return {}; }
  async updateRole(_phone: string, _updates: Record<string, any>) { return {}; }
  async verifyPhone(_phone: string) {}
  async createOTP(_phone: string, _code: string, _expiresAt: Date) {}
  async verifyOTP(_phone: string, _code: string) { return { valid: true }; }
  async findModelFuzzy(query: string): Promise<Model | undefined> {
    const q = query.toLowerCase();
    return Array.from(this.models.values()).find(m =>
      m.model.toLowerCase().includes(q) || m.slug.toLowerCase().includes(q)
    );
  }
  async getFuelPrices() { return { gnv: 12.99, magna: 24.00, premium: 26.50 }; }
  async getClientStateByPhone(_phone: string) { return null; }
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
  async createModel(data: any): Promise<Model> {
    const rows = await this.sql`INSERT INTO models (brand, model, variant, year, cmu, slug, cmu_source, purchase_benchmark_pct, cmu_updated_at)
      VALUES (${data.brand}, ${data.model}, ${data.variant || null}, ${data.year}, ${data.cmu}, ${data.slug}, ${data.cmuSource || 'mercado_auto'}, ${data.purchaseBenchmarkPct || 0.65}, ${data.cmuUpdatedAt || new Date().toISOString()})
      RETURNING *`;
    return rows[0] as Model;
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
  async findFolioFlexible(query: string): Promise<{ origination: Origination; taxistaName: string | null; matchType: string }[]> {
    const q = query.toLowerCase().trim();
    const results: { origination: Origination; taxistaName: string | null; matchType: string }[] = [];

    // "el último" / "el más reciente" / "nueva"
    if (q.includes("último") || q.includes("ultimo") || q.includes("reciente") || q.includes("nueva")) {
      const rows = await this.sql`
        SELECT o.*, t.nombre as t_nombre, t.apellido_paterno as t_apellido
        FROM originations o LEFT JOIN taxistas t ON o.taxista_id = t.id
        ORDER BY o.created_at DESC LIMIT 1`;
      if (rows.length > 0) {
        const r = rows[0] as any;
        results.push({
          origination: r as Origination,
          taxistaName: r.t_nombre ? `${r.t_nombre} ${r.t_apellido || ""}`.trim() : null,
          matchType: "más_reciente",
        });
      }
      return results;
    }

    // Search by partial folio number (e.g. "047", "260320-001", "CMU-VAL")
    const folioPattern = `%${q}%`;
    const folioRows = await this.sql`
      SELECT o.*, t.nombre as t_nombre, t.apellido_paterno as t_apellido
      FROM originations o LEFT JOIN taxistas t ON o.taxista_id = t.id
      WHERE LOWER(o.folio) LIKE ${folioPattern}
      ORDER BY o.created_at DESC LIMIT 5`;
    for (const r of folioRows) {
      const row = r as any;
      results.push({
        origination: row as Origination,
        taxistaName: row.t_nombre ? `${row.t_nombre} ${row.t_apellido || ""}`.trim() : null,
        matchType: "folio_parcial",
      });
    }

    // Search by taxista name/apellido (if not enough results from folio)
    if (results.length < 5) {
      const nameRows = await this.sql`
        SELECT o.*, t.nombre as t_nombre, t.apellido_paterno as t_apellido, t.apellido_materno as t_apellido_m
        FROM originations o JOIN taxistas t ON o.taxista_id = t.id
        WHERE LOWER(t.nombre) LIKE ${folioPattern}
           OR LOWER(t.apellido_paterno) LIKE ${folioPattern}
           OR LOWER(t.apellido_materno) LIKE ${folioPattern}
           OR LOWER(CONCAT(t.nombre, ' ', t.apellido_paterno)) LIKE ${folioPattern}
        ORDER BY o.created_at DESC LIMIT 5`;
      const existingIds = new Set(results.map(r => (r.origination as any).id));
      for (const r of nameRows) {
        const row = r as any;
        if (existingIds.has(row.id)) continue;
        results.push({
          origination: row as Origination,
          taxistaName: row.t_nombre ? `${row.t_nombre} ${row.t_apellido || ""}`.trim() : null,
          matchType: "nombre",
        });
      }
    }

    return results.slice(0, 5);
  }
  async createDocument(data: InsertDocument) {
    const source = (data as any).source || 'pwa';
    const rows = await this.sql`INSERT INTO documents (origination_id, tipo, image_data, ocr_result, ocr_confidence, edited_data, status, source, created_at) VALUES (${data.originationId}, ${data.tipo}, ${data.imageData}, ${data.ocrResult}, ${data.ocrConfidence}, ${data.editedData}, ${data.status || 'pending'}, ${source}, ${data.createdAt}) RETURNING *`;
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
    console.log(`[Storage] updateVehicle(${id}): keys=${Object.keys(data).join(',')}, precio_aseg=${m.precio_aseguradora}, rep_real=${m.reparacion_real}, gnv_mod=${m.gnv_modalidad}`);
    const rows = await this.sql`UPDATE vehicles_inventory SET 
      marca = ${m.marca}, modelo = ${m.modelo}, variante = ${m.variante || null}, anio = ${m.anio}, 
      color = ${m.color || null}, niv = ${m.niv || null}, placas = ${m.placas || null},
      cmu_valor = ${m.cmu_valor ?? m.cmuValor ?? null}, 
      costo_adquisicion = ${m.costo_adquisicion ?? m.costoAdquisicion ?? null},
      costo_reparacion = ${m.costo_reparacion ?? m.costoReparacion ?? null},
      precio_aseguradora = ${m.precio_aseguradora ?? m.precioAseguradora ?? null},
      reparacion_estimada = ${m.reparacion_estimada ?? m.reparacionEstimada ?? null},
      reparacion_real = ${m.reparacion_real ?? m.reparacionReal ?? null},
      con_tanque = ${m.con_tanque ?? m.conTanque ?? null},
      kit_gnv_instalado = ${m.kit_gnv_instalado ?? m.kitGnvInstalado ?? 0},
      kit_gnv_costo = ${m.kit_gnv_costo ?? m.kitGnvCosto ?? null},
      tanque_costo = ${m.tanque_costo ?? m.tanqueCosto ?? null},
      gnv_modalidad = ${m.gnv_modalidad ?? m.gnvModalidad ?? null},
      descuento_gnv = ${m.descuento_gnv ?? m.descuentoGnv ?? null},
      status = ${m.status}, notes = ${m.notes || null}, updated_at = ${m.updated_at}
    WHERE id = ${id} RETURNING *`;
    return rows[0] as VehicleInventory | undefined;
  }
  async deleteVehicle(id: number): Promise<void> {
    await this.sql`DELETE FROM vehicles_inventory WHERE id = ${id}`;
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
  async getContract(id: number) {
    const rows = await this.sql`SELECT * FROM contracts WHERE id = ${id} LIMIT 1`;
    return rows[0] as Contract | undefined;
  }
  async updateContract(id: number, data: Partial<InsertContract>) {
    const existing = await this.getContract(id);
    if (!existing) return undefined;
    const m: any = { ...existing, ...data };
    const rows = await this.sql`UPDATE contracts SET status = ${m.status || 'draft'} WHERE id = ${id} RETURNING *`;
    return rows[0] as Contract | undefined;
  }
  async getContractByOrigination(originationId: number) {
    const rows = await this.sql`SELECT * FROM contracts WHERE origination_id = ${originationId} LIMIT 1`;
    return rows[0] as Contract | undefined;
  }
  async getAvailableVehicles() {
    return this.sql`SELECT * FROM vehicles_inventory WHERE status = 'disponible' ORDER BY created_at DESC` as any;
  }

  // ===== WhatsApp Roles =====
  async getRoleByPhone(phone: string) {
    const cleanPhone = phone.replace(/\D/g, "");
    // Try exact match, then with/without country code variants
    const rows = await this.sql`SELECT phone, role, name, permissions, folio_id, phone_verified, active FROM whatsapp_roles WHERE phone = ${cleanPhone} AND active = true LIMIT 1`;
    if (rows.length > 0) {
      const r = rows[0] as any;
      return { phone: r.phone, role: r.role, name: r.name, permissions: r.permissions || [], folio_id: r.folio_id, phone_verified: r.phone_verified ?? false, active: r.active ?? true };
    }
    // Try without leading 521 (Mexico mobile prefix)
    if (cleanPhone.startsWith("521")) {
      const short = cleanPhone.slice(3);
      const rows2 = await this.sql`SELECT phone, role, name, permissions, folio_id, phone_verified, active FROM whatsapp_roles WHERE phone LIKE ${"%" + short} AND active = true LIMIT 1`;
      if (rows2.length > 0) {
        const r = rows2[0] as any;
        return { phone: r.phone, role: r.role, name: r.name, permissions: r.permissions || [], folio_id: r.folio_id, phone_verified: r.phone_verified ?? false, active: r.active ?? true };
      }
    }
    return null;
  }

  async createRole(phone: string, role: string, name: string | null, permissions: string[] = []) {
    const cleanPhone = phone.replace(/\D/g, "");
    const rows = await this.sql`INSERT INTO whatsapp_roles (phone, role, name, permissions, phone_verified) VALUES (${cleanPhone}, ${role}, ${name}, ${permissions as any}, false) ON CONFLICT (phone) DO UPDATE SET role = ${role}, name = ${name}, permissions = ${permissions as any} RETURNING *`;
    return rows[0];
  }

  async updateRole(phone: string, updates: Record<string, any>) {
    const cleanPhone = phone.replace(/\D/g, "");
    // Build dynamic update — simple approach
    if (updates.folio_id !== undefined) {
      await this.sql`UPDATE whatsapp_roles SET folio_id = ${updates.folio_id} WHERE phone = ${cleanPhone}`;
    }
    if (updates.role) {
      await this.sql`UPDATE whatsapp_roles SET role = ${updates.role} WHERE phone = ${cleanPhone}`;
    }
    if (updates.name) {
      await this.sql`UPDATE whatsapp_roles SET name = ${updates.name} WHERE phone = ${cleanPhone}`;
    }
    return {};
  }

  async verifyPhone(phone: string) {
    const cleanPhone = phone.replace(/\D/g, "");
    await this.sql`UPDATE whatsapp_roles SET phone_verified = true, verified_at = NOW() WHERE phone = ${cleanPhone}`;
  }

  // ===== WhatsApp OTP =====
  async createOTP(phone: string, code: string, expiresAt: Date) {
    const cleanPhone = phone.replace(/\D/g, "");
    await this.sql`INSERT INTO whatsapp_otp (phone, code, expires_at, attempts) VALUES (${cleanPhone}, ${code}, ${expiresAt.toISOString()}, 0) ON CONFLICT (phone) DO UPDATE SET code = ${code}, expires_at = ${expiresAt.toISOString()}, attempts = 0, created_at = NOW()`;
  }

  async verifyOTP(phone: string, code: string): Promise<{ valid: boolean; expired?: boolean; maxAttempts?: boolean }> {
    const cleanPhone = phone.replace(/\D/g, "");
    const rows = await this.sql`SELECT code, expires_at, attempts FROM whatsapp_otp WHERE phone = ${cleanPhone} LIMIT 1`;
    if (rows.length === 0) return { valid: false };
    const row = rows[0] as any;
    if (row.attempts >= 3) return { valid: false, maxAttempts: true };
    if (new Date(row.expires_at) < new Date()) return { valid: false, expired: true };
    if (row.code !== code) {
      await this.sql`UPDATE whatsapp_otp SET attempts = attempts + 1 WHERE phone = ${cleanPhone}`;
      return { valid: false };
    }
    // Valid — delete OTP and verify phone
    await this.sql`DELETE FROM whatsapp_otp WHERE phone = ${cleanPhone}`;
    await this.verifyPhone(cleanPhone);
    return { valid: true };
  }

  // ===== Fuzzy model lookup =====
  async findModelFuzzy(query: string): Promise<Model | undefined> {
    const q = query.toLowerCase().trim();
    // Try exact slug match first
    const rows1 = await this.sql`SELECT * FROM models WHERE LOWER(slug) = ${q} LIMIT 1`;
    if (rows1.length > 0) return rows1[0] as Model;
    // Try LIKE on slug
    const rows2 = await this.sql`SELECT * FROM models WHERE LOWER(slug) LIKE ${"%" + q.replace(/\s+/g, "%") + "%"} ORDER BY year DESC LIMIT 1`;
    if (rows2.length > 0) return rows2[0] as Model;
    // Try LIKE on model name
    const rows3 = await this.sql`SELECT * FROM models WHERE LOWER(model) LIKE ${"%" + q.replace(/\s+/g, "%") + "%"} ORDER BY year DESC LIMIT 1`;
    if (rows3.length > 0) return rows3[0] as Model;
    // Try brand + model combo
    const parts = q.split(/\s+/);
    if (parts.length >= 2) {
      const rows4 = await this.sql`SELECT * FROM models WHERE LOWER(brand) LIKE ${"%" + parts[0] + "%"} AND LOWER(model) LIKE ${"%" + parts[1] + "%"} ORDER BY year DESC LIMIT 1`;
      if (rows4.length > 0) return rows4[0] as Model;
    }
    return undefined;
  }

  // ===== Fuel Prices =====
  async getFuelPrices(): Promise<{ gnv: number; magna: number; premium: number }> {
    try {
      const rows = await this.sql`SELECT fuel_type, price_per_unit FROM fuel_prices`;
      const prices: any = { gnv: 12.99, magna: 24.00, premium: 26.50 }; // defaults
      for (const r of rows) {
        prices[r.fuel_type] = parseFloat(r.price_per_unit);
      }
      return prices;
    } catch (e: any) {
      console.error("[Storage] getFuelPrices error:", e.message);
      return { gnv: 12.99, magna: 24.00, premium: 26.50 };
    }
  }

  // ===== Client State by Phone =====
  async getClientStateByPhone(phone: string) {
    const cleanPhone = phone.replace(/\D/g, "");
    const ALL_DOCS = ["ine_frente","ine_reverso","tarjeta_circulacion","factura_vehiculo","csf","comprobante_domicilio","concesion","estado_cuenta","historial_gnv","carta_membresia","selfie_biometrico"];
    const DOC_LABELS: Record<string,string> = {ine_frente:"INE Frente",ine_reverso:"INE Reverso",tarjeta_circulacion:"Tarjeta Circulaci\u00f3n",factura_vehiculo:"Factura Veh\u00edculo",csf:"CSF",comprobante_domicilio:"Comprobante Domicilio",concesion:"Concesi\u00f3n",estado_cuenta:"Edo. Cuenta",historial_gnv:"Historial GNV",carta_membresia:"Carta Membres\u00eda",selfie_biometrico:"Selfie INE"};

    try {
      // Path 1: whatsapp_roles.folio_id
      let originationId: number | null = null;
      const roleRows = await this.sql`SELECT folio_id FROM whatsapp_roles WHERE phone = ${cleanPhone} AND folio_id IS NOT NULL LIMIT 1`;
      if (roleRows.length > 0 && roleRows[0].folio_id) {
        originationId = roleRows[0].folio_id;
      }

      // Path 2: whatsapp_phone_folio
      if (!originationId) {
        const wpfRows = await this.sql`SELECT o.id FROM whatsapp_phone_folio wpf JOIN originations o ON o.folio = wpf.folio WHERE wpf.phone LIKE ${"%" + cleanPhone.slice(-10)} ORDER BY wpf.created_at DESC LIMIT 1`;
        if (wpfRows.length > 0) originationId = wpfRows[0].id;
      }

      // Path 3: taxistas.telefono
      if (!originationId) {
        const tRows = await this.sql`SELECT o.id FROM taxistas t JOIN originations o ON o.taxista_id = t.id WHERE t.telefono LIKE ${"%" + cleanPhone.slice(-10)} ORDER BY o.created_at DESC LIMIT 1`;
        if (tRows.length > 0) originationId = tRows[0].id;
      }

      // Path 4: originations.otp_phone
      if (!originationId) {
        const otpRows = await this.sql`SELECT id FROM originations WHERE otp_phone LIKE ${"%" + cleanPhone.slice(-10)} ORDER BY created_at DESC LIMIT 1`;
        if (otpRows.length > 0) originationId = otpRows[0].id;
      }

      if (!originationId) return null;

      // Load origination
      const origRows = await this.sql`SELECT * FROM originations WHERE id = ${originationId} LIMIT 1`;
      if (origRows.length === 0) return null;
      const orig = origRows[0] as any;

      // Load taxista name
      let taxistaName: string | null = null;
      let taxistaId: number | null = orig.taxista_id || null;
      if (taxistaId) {
        const tRows = await this.sql`SELECT nombre, apellido_paterno FROM taxistas WHERE id = ${taxistaId} LIMIT 1`;
        if (tRows.length > 0) taxistaName = `${tRows[0].nombre} ${tRows[0].apellido_paterno || ""}`.trim();
      }

      // Load documents
      const docs = await this.sql`SELECT tipo, status, image_data IS NOT NULL as has_image FROM documents WHERE origination_id = ${originationId}`;
      const captured = docs.filter((d: any) => d.has_image).map((d: any) => d.tipo);
      const capturedSet = new Set(captured);
      const pending = ALL_DOCS.filter(k => !capturedSet.has(k));

      return {
        found: true,
        originationId,
        folio: orig.folio,
        estado: orig.estado,
        taxistaName,
        taxistaId,
        perfilTipo: orig.perfil_tipo,
        currentStep: orig.current_step,
        docsCapturados: captured.map((k: string) => DOC_LABELS[k] || k),
        docsPendientes: pending.map(k => DOC_LABELS[k] || k),
        totalDocs: ALL_DOCS.length,
      };
    } catch (e: any) {
      console.error("[Storage] getClientStateByPhone error:", e.message);
      return null;
    }
  }
}

// ===== Export: Use Neon if DATABASE_URL is set, otherwise MemStorage =====
const DATABASE_URL = process.env.DATABASE_URL;
export const storage: IStorage = DATABASE_URL
  ? new NeonStorage(DATABASE_URL)
  : new MemStorage();
