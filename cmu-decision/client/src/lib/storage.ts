/**
 * Client-side in-memory storage layer for CMU Decision Engine.
 * 
 * Replaces all server-side storage (server/storage.ts) with a fully
 * client-side implementation using React-friendly patterns.
 * 
 * Uses a singleton store with event-based reactivity.
 * All data is in-memory — survives page navigation but not hard refresh.
 * Seed data is initialized on first load.
 */

import type {
  Model,
  ModelOption,
  Opportunity,
  Promoter,
  Taxista,
  Origination,
  Document as DocType,
  VehicleInventory,
  Contract,
} from "@shared/schema";

// ===== Event system for reactivity =====
type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Version counter for snapshot caching (useSyncExternalStore requires
// getSnapshot to return referentially identical values when data hasn't changed)
let storeVersion = 0;
const snapshotCache = new Map<string, { version: number; value: any }>();

function cachedSnapshot<T>(key: string, compute: () => T): T {
  const cached = snapshotCache.get(key);
  if (cached && cached.version === storeVersion) return cached.value;
  const value = compute();
  snapshotCache.set(key, { version: storeVersion, value });
  return value;
}

function notify() {
  storeVersion++;
  listeners.forEach((fn) => fn());
}

// ===== Storage state =====
let models: Map<number, Model> = new Map();
let opportunities: Map<number, Opportunity> = new Map();
let promoters: Map<number, Promoter> = new Map();
let taxistas: Map<number, Taxista> = new Map();
let originations: Map<number, Origination> = new Map();
let documents: Map<number, DocType> = new Map();
let vehicles: Map<number, VehicleInventory> = new Map();
let contracts: Map<number, Contract> = new Map();

let modelSeq = 1;
let oppSeq = 1;
let promoterSeq = 1;
let taxistaSeq = 1;
let originationSeq = 1;
let documentSeq = 1;
let vehicleSeq = 1;
let contractSeq = 1;

let initialized = false;

// ===== Seed Data =====
function seedAll() {
  if (initialized) return;
  initialized = true;

  const seedDate = new Date().toISOString();

  // Seed models
  const modelSeed: Array<{
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

  for (const s of modelSeed) {
    const id = modelSeq++;
    models.set(id, {
      id, brand: s.brand, model: s.model, variant: s.variant, year: s.year,
      cmu: s.cmu, purchaseBenchmarkPct: s.benchmarkPct, slug: s.slug,
      cmuSource: "catalog", cmuUpdatedAt: seedDate,
      cmuMin: null, cmuMax: null, cmuMedian: null, cmuSampleCount: null,
    });
  }

  // Seed promoter
  const pId = promoterSeq++;
  promoters.set(pId, {
    id: pId,
    name: "Ángeles Mireles",
    pin: "123456",
    phone: "+524491234567",
    active: 1,
    createdAt: seedDate,
  });

  // Seed vehicles
  const now = new Date().toISOString();
  const vehicleSeed: Array<Omit<VehicleInventory, "id">> = [
    { marca: "Nissan", modelo: "March", variante: "Sense", anio: 2022, color: "Blanco", niv: "3N1CK3CD5NL000001", placas: "AGS-1234", numSerie: "NL000001", numMotor: "HR12DE-001234", cmuValor: 200000, costoAdquisicion: 120000, costoReparacion: 15000, status: "disponible", assignedOriginationId: null, assignedTaxistaId: null, kitGnvInstalado: 1, kitGnvCosto: 18000, kitGnvMarca: "LOVATO", kitGnvSerie: "LVT-2024-0001", tanqueTipo: "nuevo", tanqueMarca: "CILBRAS", tanqueSerie: "CIL-60L-0001", tanqueCosto: 12000, fotos: null, notes: null, createdAt: now, updatedAt: now },
    { marca: "Chevrolet", modelo: "Aveo", variante: null, anio: 2023, color: "Gris", niv: "3G1TC5CF3PL000002", placas: "AGS-5678", numSerie: "PL000002", numMotor: "B12D1-005678", cmuValor: 205000, costoAdquisicion: 108000, costoReparacion: 10000, status: "disponible", assignedOriginationId: null, assignedTaxistaId: null, kitGnvInstalado: 0, kitGnvCosto: null, kitGnvMarca: null, kitGnvSerie: null, tanqueTipo: null, tanqueMarca: null, tanqueSerie: null, tanqueCosto: null, fotos: null, notes: "Pendiente instalación kit GNV", createdAt: now, updatedAt: now },
    { marca: "Nissan", modelo: "V-Drive", variante: null, anio: 2022, color: "Rojo", niv: "3N1CK3CD7NL000003", placas: "AGS-9012", numSerie: "NL000003", numMotor: "HR16DE-009012", cmuValor: 221000, costoAdquisicion: 132000, costoReparacion: 8000, status: "en_reparacion", assignedOriginationId: null, assignedTaxistaId: null, kitGnvInstalado: 1, kitGnvCosto: 18000, kitGnvMarca: "TOMASETTO", kitGnvSerie: "TMS-2024-0003", tanqueTipo: "reusado", tanqueMarca: "CILBRAS", tanqueSerie: "CIL-60L-R003", tanqueCosto: 8000, fotos: null, notes: "En taller, estimado 1 semana", createdAt: now, updatedAt: now },
    { marca: "Nissan", modelo: "March", variante: "Advance", anio: 2021, color: "Azul", niv: "3N1CK3CD1ML000004", placas: "AGS-3456", numSerie: "ML000004", numMotor: "HR12DE-003456", cmuValor: 224000, costoAdquisicion: 134000, costoReparacion: 12000, status: "asignado", assignedOriginationId: null, assignedTaxistaId: null, kitGnvInstalado: 1, kitGnvCosto: 18000, kitGnvMarca: "LOVATO", kitGnvSerie: "LVT-2024-0004", tanqueTipo: "nuevo", tanqueMarca: "WORTHINGTON", tanqueSerie: "WTH-60L-0004", tanqueCosto: 12000, fotos: null, notes: null, createdAt: now, updatedAt: now },
  ];

  for (const v of vehicleSeed) {
    const id = vehicleSeq++;
    vehicles.set(id, { id, ...v });
  }
}

// ===== Public API =====

export function initStore() {
  seedAll();
}

// --- Models ---
export function getModels(): Model[] {
  seedAll();
  return cachedSnapshot('models', () => Array.from(models.values()));
}

export function getModelOptions(): ModelOption[] {
  seedAll();
  return cachedSnapshot('modelOptions', () => Array.from(models.values()).map((m) => ({
    id: m.id, brand: m.brand, model: m.model, variant: m.variant,
    year: m.year, cmu: m.cmu, slug: m.slug,
    displayName: m.variant ? `${m.model} ${m.variant}` : m.model,
    cmuSource: m.cmuSource, cmuUpdatedAt: m.cmuUpdatedAt,
    cmuMin: m.cmuMin, cmuMax: m.cmuMax, cmuMedian: m.cmuMedian, cmuSampleCount: m.cmuSampleCount,
  })));
}

export function getModelById(id: number): Model | undefined {
  seedAll();
  return models.get(id);
}

export function updateModel(id: number, data: Partial<Model>): Model | undefined {
  seedAll();
  const m = models.get(id);
  if (!m) return undefined;
  const updated = { ...m, ...data, cmuUpdatedAt: new Date().toISOString() };
  models.set(id, updated);
  notify();
  return updated;
}

export function addModel(data: Omit<Model, "id">): Model {
  seedAll();
  const id = modelSeq++;
  const m: Model = { ...data, id };
  models.set(id, m);
  notify();
  return m;
}

export function deleteModel(id: number): boolean {
  seedAll();
  const existed = models.delete(id);
  if (existed) notify();
  return existed;
}

/** Replace all models with data from API (Neon sync) */
export function replaceModels(apiModels: Model[]): void {
  models.clear();
  let maxId = 0;
  for (const m of apiModels) {
    models.set(m.id, m);
    if (m.id > maxId) maxId = m.id;
  }
  modelSeq = maxId + 1;
  notify(); // increments storeVersion which invalidates cachedSnapshots
}

// --- Opportunities ---
export function saveOpportunity(opp: Omit<Opportunity, "id" | "createdAt">): Opportunity {
  seedAll();
  const id = oppSeq++;
  const full: Opportunity = { ...opp, id, createdAt: new Date() };
  opportunities.set(id, full);
  notify();
  return full;
}

export function getOpportunities(): Opportunity[] {
  seedAll();
  return cachedSnapshot('opportunities', () => Array.from(opportunities.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
}

// --- Promoters ---
export function getPromoterByPin(pin: string): Promoter | undefined {
  seedAll();
  return Array.from(promoters.values()).find((p) => p.pin === pin && p.active === 1);
}

// --- Taxistas ---
export function createTaxista(data: Omit<Taxista, "id">): Taxista {
  seedAll();
  const id = taxistaSeq++;
  const taxista: Taxista = { ...data, id };
  taxistas.set(id, taxista);
  notify();
  return taxista;
}

export function getTaxista(id: number): Taxista | undefined {
  seedAll();
  return taxistas.get(id);
}

// --- Originations ---
export function createOrigination(data: Omit<Origination, "id">): Origination {
  seedAll();
  const id = originationSeq++;
  const orig: Origination = { ...data, id };
  originations.set(id, orig);
  notify();
  return orig;
}

export function getOrigination(id: number): Origination | undefined {
  seedAll();
  return cachedSnapshot(`orig-${id}`, () => originations.get(id));
}

export function updateOrigination(id: number, data: Partial<Origination>): Origination | undefined {
  seedAll();
  const orig = originations.get(id);
  if (!orig) return undefined;
  const updated = { ...orig, ...data, updatedAt: new Date().toISOString() };
  originations.set(id, updated);
  notify();
  return updated;
}

export function listOriginations(): Origination[] {
  seedAll();
  return cachedSnapshot('originations', () => Array.from(originations.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}

export function getNextFolioSequence(prefix: string, dateStr: string): number {
  seedAll();
  const pattern = `${prefix}-${dateStr}-`;
  const existing = Array.from(originations.values())
    .filter((o) => o.folio.startsWith(pattern));
  return existing.length + 1;
}

// --- Documents ---
export function createDocument(data: Omit<DocType, "id">): DocType {
  seedAll();
  const id = documentSeq++;
  const doc: DocType = { ...data, id };
  documents.set(id, doc);
  notify();
  return doc;
}

export function getDocumentsByOrigination(originationId: number): DocType[] {
  seedAll();
  return cachedSnapshot(`docs-${originationId}`, () => Array.from(documents.values())
    .filter((d) => d.originationId === originationId));
}

export function getDocumentByOriginationAndType(originationId: number, tipo: string): DocType | undefined {
  seedAll();
  return Array.from(documents.values())
    .find((d) => d.originationId === originationId && d.tipo === tipo);
}

export function updateDocument(id: number, data: Partial<DocType>): DocType | undefined {
  seedAll();
  const doc = documents.get(id);
  if (!doc) return undefined;
  const updated = { ...doc, ...data };
  documents.set(id, updated);
  notify();
  return updated;
}

// --- Vehicles ---
export function createVehicle(data: Omit<VehicleInventory, "id">): VehicleInventory {
  seedAll();
  const id = vehicleSeq++;
  const vehicle: VehicleInventory = { ...data, id };
  vehicles.set(id, vehicle);
  notify();
  return vehicle;
}

export function getVehicle(id: number): VehicleInventory | undefined {
  seedAll();
  return vehicles.get(id);
}

export function updateVehicle(id: number, data: Partial<VehicleInventory>): VehicleInventory | undefined {
  seedAll();
  const vehicle = vehicles.get(id);
  if (!vehicle) return undefined;
  const updated = { ...vehicle, ...data, updatedAt: new Date().toISOString() };
  vehicles.set(id, updated);
  notify();
  return updated;
}

export function listVehicles(): VehicleInventory[] {
  seedAll();
  return cachedSnapshot('vehicles', () => Array.from(vehicles.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}

// --- Contracts ---
export function createContract(data: Omit<Contract, "id">): Contract {
  seedAll();
  const id = contractSeq++;
  const contract: Contract = { ...data, id };
  contracts.set(id, contract);
  notify();
  return contract;
}

export function getContractByOrigination(originationId: number): Contract | undefined {
  seedAll();
  return Array.from(contracts.values())
    .find((c) => c.originationId === originationId);
}
