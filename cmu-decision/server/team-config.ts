/**
 * Team Configuration — Central reference for all team members
 * 
 * Change here when adding promotoras or updating contact info.
 * All other files reference this config instead of hardcoding names/phones.
 */

export const DIRECTOR = {
  nombre: "Josué Hernández",
  phone: "5214422022540",
  pin: "654321",
  role: "director" as const,
};

export const PROMOTORES = [
  {
    id: "promotor_1",
    nombre: "Ángeles Mireles",
    phone: "5214493845228",
    pin: "123456",
    role: "promotora" as const,
    activo: true,
  },
  // Add more promotores here:
  // {
  //   id: "promotor_2",
  //   nombre: "...",
  //   phone: "...",
  //   pin: "...",
  //   role: "promotora" as const,
  //   activo: true,
  // },
];

// Helper: get active promotor (for now just the first one)
export function getPromotor(id?: string) {
  if (id) return PROMOTORES.find(p => p.id === id);
  return PROMOTORES.find(p => p.activo) || PROMOTORES[0];
}

// Helper: get all phones to notify (director + active promotores)
export function getNotifyPhones(): string[] {
  return [
    DIRECTOR.phone,
    ...PROMOTORES.filter(p => p.activo).map(p => p.phone),
  ];
}

// For display in messages to clients — generic, not name-specific
export const PROMOTOR_LABEL = "tu asesor(a) CMU";

// Company info
export const EMPRESA = {
  nombre: "Conductores del Mundo, S.A.P.I. de C.V.",
  ciudad: "Aguascalientes, Ags.",
};
