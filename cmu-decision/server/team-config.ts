/**
 * Team Configuration — Central reference for all team members
 * 
 * Change here when adding team members or updating contact info.
 * All other files reference this config instead of hardcoding names/phones.
 */

export const DIRECTOR = {
  nombre: "Josué Hernández",
  phone: "5214422022540",
  pin: "654321",
  role: "director" as const,
};

// NOTA: el sistema es multi-promotor.
// - `id` es el identificador genérico (promotor_uno, promotor_dos, ...) — NUNCA usar nombres en UI/copy/docs.
// - `nombreInterno` queda para referencia interna (debug, logs) pero NO se muestra al cliente ni al promotor.
// - `label` es lo que se muestra en la UI ("Promotor", "Promotor 2", etc.).
export const PROMOTORES = [
  {
    id: "promotor_uno",
    label: "Promotor",
    nombreInterno: "Ángeles Mireles",
    phone: "5214493845228",
    pin: "123456",
    role: "promotora" as const,
    activo: true,
    dbPromoterId: 1, // FK a tabla promoters (para filtrar originations)
  },
];

/** Lookup por id genérico o numérico. */
export function getPromotorBy(opts: { id?: string; phone?: string; dbId?: number }) {
  if (opts.id) return PROMOTORES.find(p => p.id === opts.id);
  if (opts.phone) return PROMOTORES.find(p => p.phone === opts.phone);
  if (opts.dbId !== undefined) return PROMOTORES.find(p => p.dbPromoterId === opts.dbId);
  return null;
}

export const DEVS = [
  {
    id: "dev_1",
    nombre: "Pablo Prado",
    phone: "524433570533",
    pin: "111111",
    role: "dev" as const,
    activo: true,
  },
  {
    id: "dev_2",
    nombre: "Dagoberto Prado",
    phone: "524433181417",
    pin: "111111",
    role: "dev" as const,
    activo: true,
  },
];

export const PROVEEDORES = [
  {
    id: "proveedor_1",
    nombre: "Lilia Plata",
    phone: "524421146330",
    empresa: "NATGAS",
    role: "proveedor" as const,
    activo: true,
  },
];

// Helper: get active promotor (for now just the first one)
export function getPromotor(id?: string) {
  if (id) return PROMOTORES.find(p => p.id === id);
  return PROMOTORES.find(p => p.activo) || PROMOTORES[0];
}

/** Label público de un promotor (para UI/mensajes al cliente). */
export function getPromotorLabel(id?: string): string {
  const p = getPromotor(id);
  return p?.label || "tu asesor(a) CMU";
}

// Helper: get all phones to notify (director + active promotores)
export function getNotifyPhones(): string[] {
  return [
    DIRECTOR.phone,
    ...PROMOTORES.filter(p => p.activo).map(p => p.phone),
  ];
}

// Convenience phone exports (E.164 without + prefix)
export const JOSUE_PHONE = DIRECTOR.phone;
export const ANGELES_PHONE = PROMOTORES[0].phone;
export const LILIA_PHONE = PROVEEDORES[0].phone;

// For display in messages to clients — generic, not name-specific
export const PROMOTOR_LABEL = "tu asesor(a) CMU";

// Company info
export const EMPRESA = {
  nombre: "Conductores del Mundo, S.A.P.I. de C.V.",
  ciudad: "Aguascalientes, Ags.",
};
