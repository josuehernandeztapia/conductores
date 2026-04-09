import type { Express, Request, Response } from "express";
import { storage } from "./storage";
import { sql } from "./db";
import { isCatalogoRequest, registerCatalogoRoutes } from "./catalogo-routes";

// ====== CATALOGO HTML SERVER — SSR for catalogo.conductores.lat ======
// Serves HTML pages with OG tags for WhatsApp/social sharing

function escapeHtml(str: string): string {
  return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function catalogoLayout(title: string, description: string, ogImage: string, ogUrl: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:image" content="${escapeHtml(ogImage)}">
  <meta property="og:url" content="${escapeHtml(ogUrl)}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="https://conductores.lat/favicon.ico">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; color: #333; }
    .header { background: #1a1a2e; color: white; padding: 1rem 2rem; text-align: center; }
    .header h1 { font-size: 1.5rem; }
    .header p { font-size: 0.9rem; opacity: 0.8; margin-top: 0.25rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1.5rem; padding: 2rem; max-width: 1200px; margin: 0 auto; }
    .card { background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); transition: transform 0.2s; }
    .card:hover { transform: translateY(-4px); box-shadow: 0 4px 16px rgba(0,0,0,0.15); }
    .card img { width: 100%; height: 200px; object-fit: cover; background: #f0f0f0; }
    .card-body { padding: 1rem; }
    .card-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.5rem; }
    .card-year { color: #666; font-size: 0.9rem; }
    .card-price { font-size: 1.3rem; font-weight: 700; color: #16a34a; margin-top: 0.5rem; }
    .card-status { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 20px; font-size: 0.75rem; font-weight: 600; margin-top: 0.5rem; }
    .status-disponible { background: #dcfce7; color: #16a34a; }
    .status-apartado { background: #fef3c7; color: #d97706; }
    .card a { text-decoration: none; color: inherit; }
    .whatsapp-btn { display: inline-block; background: #25d366; color: white; padding: 0.5rem 1rem; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 0.75rem; font-size: 0.9rem; }
    .footer { text-align: center; padding: 2rem; color: #666; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Conductores del Mundo</h1>
    <p>Cat\u00e1logo de Veh\u00edculos Disponibles</p>
  </div>
  ${body}
  <div class="footer">
    <p>&copy; 2026 Conductores del Mundo. Quer\u00e9taro, M\u00e9xico.</p>
  </div>
</body>
</html>`;
}

export function registerCatalogoHtml(app: Express) {
  // Middleware: if request is for catalogo host, intercept HTML routes
  app.use((req: Request, res: Response, next) => {
    if (!isCatalogoRequest(req)) return next();
    
    // Let /api routes pass through to catalogo-routes
    if (req.path.startsWith("/api/")) return next();
    
    // Serve HTML for catalogo pages
    if (req.path === "/" || req.path === "") {
      return serveCatalogoGrid(req, res);
    }
    
    // /:slug route
    const slug = req.path.replace(/^\//, "").replace(/\/$/, "");
    if (slug && !slug.includes("/")) {
      return serveCatalogoFicha(req, res, slug);
    }
    
    next();
  });
  
  // Register API routes for catalogo
  registerCatalogoRoutes(app);
}

async function serveCatalogoGrid(_req: Request, res: Response) {
  try {
    const rows_grid = await sql`SELECT id, marca, modelo, variante, anio, color, precio_venta_final, status, foto_url, slug, destacado FROM vehicles_inventory WHERE status != 'vendido' ORDER BY destacado DESC, id DESC`;
    
    const cards = rows_grid.map((v: any) => {
      const name = `${v.marca} ${v.modelo} ${v.variante || ''}`.trim();
      const price = v.precio_venta_final ? `$${Number(v.precio_venta_final).toLocaleString('es-MX')} MXN` : 'Consultar';
      const statusClass = v.status === 'disponible' ? 'status-disponible' : 'status-apartado';
      const img = v.foto_url || 'https://via.placeholder.com/400x250/f0f0f0/999?text=' + encodeURIComponent(name);
      return `<div class="card">
        <a href="/${v.slug}">
          <img src="${escapeHtml(img)}" alt="${escapeHtml(name)}" loading="lazy">
          <div class="card-body">
            <div class="card-title">${escapeHtml(name)}</div>
            <div class="card-year">${v.anio} ${v.color ? '\u00b7 ' + v.color : ''}</div>
            <div class="card-price">${price}</div>
            <span class="card-status ${statusClass}">${v.status || 'disponible'}</span>
          </div>
        </a>
      </div>`;
    }).join('\n');
    
    const html = catalogoLayout(
      'Cat\u00e1logo de Veh\u00edculos | Conductores del Mundo',
      'Encuentra tu pr\u00f3ximo veh\u00edculo. Modelos disponibles con financiamiento.',
      'https://conductores.lat/og-image.png',
      'https://catalogo.conductores.lat',
      `<div class="grid">${cards}</div>`
    );
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('Error serving catalogo grid:', err);
    res.status(500).send('Error al cargar cat\u00e1logo');
  }
}

async function serveCatalogoFicha(_req: Request, res: Response, slug: string) {
  try {
    const rows_ficha = await sql`SELECT id, marca, modelo, variante, anio, color, precio_venta_final, status, foto_url, slug, enganche_minimo, plazo_meses, pago_mensual_estimado FROM vehicles_inventory WHERE slug = ${slug}`;

    if (rows_ficha.length === 0) {
      res.status(404);
      const html = catalogoLayout('No encontrado', 'Veh\u00edculo no encontrado', '', '', '<div style="text-align:center;padding:4rem;"><h2>Veh\u00edculo no encontrado</h2><p><a href="/">Ver cat\u00e1logo</a></p></div>');
      return res.send(html);
    }

    const v = rows_ficha[0];
    const name = `${v.marca} ${v.modelo} ${v.variante || ''}`.trim();
    const price = v.precio_venta_final ? `$${Number(v.precio_venta_final).toLocaleString('es-MX')} MXN` : 'Consultar';
    const img = v.foto_url || 'https://via.placeholder.com/600x400/f0f0f0/999?text=' + encodeURIComponent(name);
    const waMsg = encodeURIComponent(`Hola, me interesa el ${name} ${v.anio} que vi en el cat\u00e1logo.`);
    
    const body = `<div style="max-width:800px;margin:2rem auto;padding:0 1rem;">
      <a href="/" style="color:#666;text-decoration:none;">&larr; Volver al cat\u00e1logo</a>
      <div style="background:white;border-radius:12px;overflow:hidden;margin-top:1rem;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
        <img src="${escapeHtml(img)}" alt="${escapeHtml(name)}" style="width:100%;max-height:400px;object-fit:cover;">
        <div style="padding:1.5rem;">
          <h2>${escapeHtml(name)}</h2>
          <p style="color:#666;margin-top:0.25rem;">${v.anio} ${v.color ? '\u00b7 ' + v.color : ''}</p>
          <div style="font-size:1.8rem;font-weight:700;color:#16a34a;margin:1rem 0;">${price}</div>
          ${v.enganche_minimo ? `<p>Enganche desde: <strong>$${Number(v.enganche_minimo).toLocaleString('es-MX')} MXN</strong></p>` : ''}
          ${v.pago_mensual_estimado ? `<p>Pago mensual estimado: <strong>$${Number(v.pago_mensual_estimado).toLocaleString('es-MX')} MXN</strong></p>` : ''}
          ${v.plazo_meses ? `<p>Plazo: <strong>${v.plazo_meses} meses</strong></p>` : ''}
          <a href="https://wa.me/524422022540?text=${waMsg}" class="whatsapp-btn" target="_blank">Preguntar por WhatsApp</a>
        </div>
      </div>
    </div>`;
    
    const html = catalogoLayout(
      `${name} ${v.anio} | Conductores del Mundo`,
      `${name} ${v.anio} disponible. Precio: ${price}. Financiamiento disponible.`,
      img,
      `https://catalogo.conductores.lat/${v.slug}`,
      body
    );
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('Error serving catalogo ficha:', err);
    res.status(500).send('Error al cargar veh\u00edculo');
  }
}
