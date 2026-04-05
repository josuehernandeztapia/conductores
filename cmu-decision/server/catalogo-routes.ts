import type { Express, Request, Response } from "express";
import { neon } from "@neondatabase/serverless";

// ====== CATALOGO PUBLICO — catalogo.conductores.lat ======
// Solo expone datos seguros: marca, modelo, variante, año, color, precio, status, foto, slug
// NUNCA expone: costos, márgenes, TIR, NIV, datos internos

const CATALOGO_HOSTS = ["catalogo.conductores.lat", "www.catalogo.conductores.lat"];

function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  return neon(url);
}

export function isCatalogoRequest(req: Request): boolean {
  const host = (req.hostname || req.headers.host || "").replace(/:\d+$/, "");
  return CATALOGO_HOSTS.includes(host);
}

export function registerCatalogoRoutes(app: Express) {
  // GET /api/inventario/public — lista completa para el grid
  app.get("/api/inventario/public", async (_req: Request, res: Response) => {
    try {
      const sql = getSql();
      const vehicles = await sql`
        SELECT id, marca, modelo, variante, anio, color,
          precio_venta_final, status, foto_url, slug,
          destacado, orden
        FROM vehicles_inventory 
        WHERE status != 'vendido'
        ORDER BY orden ASC, destacado DESC, id DESC
      `;
      
      const publicVehicles = vehicles.map((v: any) => ({
        id: v.id,
        marca: v.marca,
        modelo: v.modelo,
        variante: v.variante,
        anio: v.anio,
        color: v.color,
        precio: v.precio_venta_final,
        status: v.status,
        foto_url: v.foto_url,
        slug: v.slug,
        destacado: v.destacado,
      }));
      
      res.json({ vehicles: publicVehicles, count: publicVehicles.length });
    } catch (err: any) {
      console.error("Error fetching public inventory:", err);
      res.status(500).json({ error: "Error al obtener inventario" });
    }
  });

  // GET /api/inventario/public/:slug — ficha individual
  app.get("/api/inventario/public/:slug", async (req: Request, res: Response) => {
    try {
      const sql = getSql();
      const { slug } = req.params;
      const vehicles = await sql`
        SELECT id, marca, modelo, variante, anio, color,
          precio_venta_final, status, foto_url, slug,
          destacado, enganche_minimo, plazo_meses, pago_mensual_estimado
        FROM vehicles_inventory 
        WHERE slug = ${slug}
      `;
      
      if (vehicles.length === 0) {
        return res.status(404).json({ error: "Veh\u00edculo no encontrado" });
      }
      
      const v = vehicles[0];
      res.json({
        id: v.id,
        marca: v.marca,
        modelo: v.modelo,
        variante: v.variante,
        anio: v.anio,
        color: v.color,
        precio: v.precio_venta_final,
        status: v.status,
        foto_url: v.foto_url,
        slug: v.slug,
        destacado: v.destacado,
        enganche_minimo: v.enganche_minimo,
        plazo_meses: v.plazo_meses,
        pago_mensual: v.pago_mensual_estimado,
        og: {
          title: `${v.marca} ${v.modelo} ${v.variante || ''} ${v.anio} | Conductores del Mundo`,
          description: `${v.marca} ${v.modelo} ${v.anio} disponible. Precio: $${Number(v.precio_venta_final || 0).toLocaleString()} MXN. Financiamiento disponible.`,
          image: v.foto_url,
          url: `https://catalogo.conductores.lat/${v.slug}`,
        },
      });
    } catch (err: any) {
      console.error("Error fetching vehicle by slug:", err);
      res.status(500).json({ error: "Error al obtener veh\u00edculo" });
    }
  });
}
