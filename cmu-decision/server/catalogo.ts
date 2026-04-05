/**
 * catalogo.ts — Public vehicle catalog for catalogo.conductores.lat
 * 
 * Serves:
 *   GET /                → Grid of available vehicles (SSR HTML)
 *   GET /:slug           → Individual vehicle card with calculator (SSR HTML)
 *   GET /api/inventario/public  → JSON API (public-safe fields only)
 *   GET /api/inventario/public/:slug → JSON API single vehicle
 * 
 * NEVER exposes: costos, márgenes, TIR, NIV, num_serie, num_motor,
 *   assigned_taxista_id, assigned_origination_id, or any internal fields.
 */

import { Router, type Request, type Response } from "express";
import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL || "";

interface PublicVehicle {
  id: number;
  marca: string;
  modelo: string;
  variante: string | null;
  anio: number;
  color: string | null;
  precio: number;
  status: string;
  slug: string;
  foto_url: string | null;
  destacado: boolean;
  con_tanque: boolean;
  gnv_modalidad: string | null;
}

async function getPublicInventory(): Promise<PublicVehicle[]> {
  const sql = neon(DATABASE_URL);
  const rows = await sql`
    SELECT id, marca, modelo, variante, anio, color, cmu_valor as precio,
           status, slug, foto_url, destacado, con_tanque, gnv_modalidad
    FROM vehicles_inventory
    WHERE status IN ('disponible', 'apartado', 'en_preparacion')
    ORDER BY orden ASC, id ASC
  `;
  return rows as PublicVehicle[];
}

async function getPublicVehicleBySlug(slug: string): Promise<PublicVehicle | null> {
  const sql = neon(DATABASE_URL);
  const rows = await sql`
    SELECT id, marca, modelo, variante, anio, color, cmu_valor as precio,
           status, slug, foto_url, destacado, con_tanque, gnv_modalidad
    FROM vehicles_inventory
    WHERE slug = ${slug}
  `;
  return rows.length > 0 ? (rows[0] as PublicVehicle) : null;
}

// ===== Financial calculator (same logic as renovacion.html) =====
const TASA_M = 0.299 / 12;
const N = 36;
const ANT = 50000;
const FG_I = 8000;
const FG_M = 334;

function buildAmort(precio: number, leq = 400, tarifa = 11) {
  const recaudo = leq * tarifa;
  let saldo = precio;
  const capitalFijo = precio / N;
  const rows: { mes: number; cuota: number; saldo: number; bolsillo: number; fgA: number }[] = [];
  let fgAcum = FG_I;

  for (let m = 1; m <= N; m++) {
    if (m === 3) saldo -= ANT;
    const interes = saldo * TASA_M;
    const cuota = capitalFijo + interes;
    const diff = Math.max(0, cuota - recaudo);
    const fgA = FG_M;
    fgAcum = Math.min(20000, fgAcum + fgA);
    saldo -= capitalFijo;
    rows.push({ mes: m, cuota: Math.round(cuota), saldo: Math.round(saldo), bolsillo: Math.round(diff + fgA), fgA });
  }
  return { rows, recaudo };
}

function vehicleName(v: PublicVehicle): string {
  return [v.marca, v.modelo, v.variante, v.anio].filter(Boolean).join(" ");
}

function fmt(n: number): string {
  return "$" + Math.round(n).toLocaleString("es-MX");
}

function statusBadge(status: string): string {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    disponible: { bg: "#00C48C", text: "#fff", label: "Disponible" },
    apartado: { bg: "#F4A261", text: "#fff", label: "Apartado" },
    en_preparacion: { bg: "#00AEEF", text: "#fff", label: "En preparación" },
  };
  const s = map[status] || map.disponible;
  return `<span style="background:${s.bg};color:${s.text};padding:3px 10px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:.3px;text-transform:uppercase">${s.label}</span>`;
}

// ===== OG Meta tags for WhatsApp preview =====
function ogTags(v: PublicVehicle | null, baseUrl: string): string {
  if (!v) {
    return `
      <meta property="og:title" content="Inventario CMU — Programa de Renovación de Taxi con GNV">
      <meta property="og:description" content="Sin buró de crédito · Sin aval · Vehículos disponibles para taxistas de Aguascalientes">
      <meta property="og:type" content="website">
      <meta property="og:url" content="${baseUrl}">
    `;
  }
  const name = vehicleName(v);
  const { rows } = buildAmort(v.precio);
  return `
    <meta property="og:title" content="${name} — ${fmt(v.precio)} | CMU">
    <meta property="og:description" content="Cuota desde ${fmt(rows[2].cuota)}/mes · Kit GNV incluido · Sin buró · Sin aval">
    <meta property="og:image" content="${baseUrl}${v.foto_url || '/vehicles/default.png'}">
    <meta property="og:type" content="product">
    <meta property="og:url" content="${baseUrl}/${v.slug}">
  `;
}

// ===== Shared HTML shell =====
function htmlShell(title: string, ogMeta: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
${ogMeta}
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #0D1B2A;
  --card: #1B2838;
  --card-hover: #223347;
  --text: #E0E6ED;
  --muted: #8899AA;
  --verde: #00C48C;
  --cyan: #00AEEF;
  --azul: #1B4D8E;
  --amber: #F4A261;
  --rojo: #E76F51;
  --raj: 'Rajdhani', sans-serif;
  --inter: 'Inter', sans-serif;
  --mono: 'JetBrains Mono', monospace;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { background:var(--bg); color:var(--text); font-family:var(--inter); line-height:1.5; -webkit-font-smoothing:antialiased; }
a { color:inherit; text-decoration:none; }

/* Header */
.header {
  padding:20px 24px;
  background:linear-gradient(135deg, #0D1B2A 0%, #1B4D8E 100%);
  border-bottom:1px solid rgba(255,255,255,.06);
}
.header-inner {
  max-width:1100px; margin:0 auto;
  display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;
}
.logo { font-family:var(--raj); font-size:18px; font-weight:700; letter-spacing:1px; color:var(--verde); }
.logo-sub { font-size:11px; color:var(--muted); font-family:var(--mono); }
.badges { display:flex; gap:6px; flex-wrap:wrap; }
.badge {
  padding:3px 10px; border-radius:4px; font-family:var(--raj);
  font-size:11px; font-weight:600; letter-spacing:.4px;
}
.badge-verde { background:var(--verde); color:#fff; }
.badge-cyan { background:var(--cyan); color:#fff; }
.badge-ghost { background:rgba(255,255,255,.1); color:var(--text); }

/* Grid */
.container { max-width:1100px; margin:0 auto; padding:24px 20px 60px; }
.section-title {
  font-family:var(--raj); font-size:13px; font-weight:600;
  letter-spacing:2px; text-transform:uppercase; color:var(--muted); margin-bottom:16px;
}
.grid {
  display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr));
  gap:16px;
}

/* Card */
.card {
  background:var(--card); border-radius:12px; overflow:hidden;
  border:1px solid rgba(255,255,255,.04);
  transition:transform .15s, border-color .15s, box-shadow .15s;
  cursor:pointer; position:relative;
}
.card:hover { transform:translateY(-2px); border-color:rgba(0,196,140,.2); box-shadow:0 8px 24px rgba(0,0,0,.3); }
.card-img {
  width:100%; height:200px; object-fit:contain;
  background:linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
  padding:12px;
}
.card-body { padding:16px 18px 18px; }
.card-name { font-family:var(--raj); font-size:18px; font-weight:700; margin-bottom:2px; }
.card-details { font-size:12px; color:var(--muted); margin-bottom:10px; }
.card-price { font-family:var(--raj); font-size:26px; font-weight:700; color:var(--verde); }
.card-cuota { font-size:12px; color:var(--cyan); margin-top:2px; }
.card-badge { position:absolute; top:12px; right:12px; }
.card-tag-popular {
  position:absolute; top:12px; left:12px;
  background:var(--amber); color:#fff; padding:2px 8px; border-radius:4px;
  font-family:var(--raj); font-size:10px; font-weight:700; letter-spacing:.5px; text-transform:uppercase;
}
.card-gnv {
  display:inline-flex; align-items:center; gap:4px;
  background:rgba(0,196,140,.1); color:var(--verde); padding:3px 8px; border-radius:4px;
  font-size:11px; font-weight:500; margin-top:8px;
}

/* Ficha individual */
.ficha { max-width:800px; margin:0 auto; }
.ficha-hero {
  background:linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
  border-radius:12px; overflow:hidden; margin-bottom:20px; text-align:center;
}
.ficha-hero img { max-height:320px; width:auto; max-width:100%; padding:20px; object-fit:contain; }
.ficha-header { display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px; margin-bottom:20px; }
.ficha-name { font-family:var(--raj); font-size:28px; font-weight:700; }
.ficha-price { font-family:var(--raj); font-size:32px; font-weight:700; color:var(--verde); text-align:right; }
.ficha-price-label { font-size:11px; color:var(--muted); font-family:var(--mono); text-transform:uppercase; letter-spacing:1px; }

/* Stats grid */
.stats { display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-bottom:20px; }
.stat {
  background:var(--card); border-radius:8px; padding:14px; text-align:center;
  border:1px solid rgba(255,255,255,.04);
}
.stat-label { font-size:10px; font-family:var(--mono); letter-spacing:1px; text-transform:uppercase; color:var(--muted); margin-bottom:4px; }
.stat-val { font-family:var(--raj); font-size:22px; font-weight:700; }
.stat-sub { font-size:11px; color:var(--muted); margin-top:2px; }

/* Comparativo */
.comp { background:var(--card); border-radius:10px; padding:18px 20px; margin-bottom:16px; border:1px solid rgba(255,255,255,.04); }
.comp-title { font-family:var(--raj); font-size:15px; font-weight:700; margin-bottom:10px; border-bottom:2px solid var(--cyan); padding-bottom:6px; }
.comp-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:12px; }
.comp-box { border-radius:8px; padding:12px; text-align:center; }
.comp-box-label { font-size:10px; font-family:var(--mono); letter-spacing:.5px; text-transform:uppercase; margin-bottom:4px; }
.comp-box-val { font-family:var(--raj); font-size:20px; font-weight:700; }
.comp-box-sub { font-size:11px; color:var(--muted); margin-top:2px; }
.comp-detail { background:rgba(0,196,140,.06); border:1px solid rgba(0,196,140,.15); border-radius:7px; padding:12px 16px; font-size:13px; line-height:1.6; }

/* Timeline */
.timeline { margin-bottom:20px; }
.tl-item {
  display:grid; grid-template-columns:80px 1fr; gap:12px;
  padding:10px 0; border-bottom:1px solid rgba(255,255,255,.04);
}
.tl-when { font-family:var(--mono); font-size:12px; color:var(--cyan); font-weight:500; }
.tl-what { font-size:13px; }

/* Slider */
.slider-group { margin-bottom:16px; }
.slider-label { font-size:12px; font-family:var(--mono); color:var(--muted); letter-spacing:.5px; text-transform:uppercase; margin-bottom:4px; }
.slider-row { display:flex; align-items:center; gap:12px; }
.slider-row input[type=range] { flex:1; accent-color:var(--verde); }
.slider-val { font-family:var(--raj); font-size:18px; font-weight:700; color:var(--verde); min-width:50px; text-align:right; }

/* CTA */
.cta {
  display:block; width:100%; padding:14px; border:none; border-radius:10px;
  background:var(--verde); color:#fff; font-family:var(--raj); font-size:16px;
  font-weight:700; letter-spacing:.5px; text-align:center; cursor:pointer;
  transition:background .15s;
}
.cta:hover { background:#00A876; }
.cta-wa { background:#25D366; }
.cta-wa:hover { background:#1EBE5A; }
.cta-section {
  text-align:center; padding:28px 20px; margin-top:24px;
  background:var(--azul); border-radius:12px;
}
.cta-section-title { font-family:var(--raj); font-size:22px; font-weight:700; margin-bottom:4px; }
.cta-section-sub { font-size:13px; color:rgba(255,255,255,.5); margin-bottom:14px; }

/* Back link */
.back { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:var(--muted); margin-bottom:16px; }
.back:hover { color:var(--verde); }

/* Footer */
.footer { text-align:center; padding:20px; font-size:11px; color:rgba(255,255,255,.2); font-family:var(--mono); }

/* Responsive */
@media (max-width:640px) {
  .grid { grid-template-columns:1fr; }
  .stats { grid-template-columns:1fr 1fr; }
  .comp-grid { grid-template-columns:1fr; }
  .ficha-header { flex-direction:column; }
  .ficha-price { text-align:left; }
  .header-inner { flex-direction:column; align-items:flex-start; }
}
</style>
</head>
<body>
<div class="header">
  <div class="header-inner">
    <div>
      <div class="logo">CONDUCTORES DEL MUNDO</div>
      <div class="logo-sub">Programa de Renovación de Taxi con GNV · Aguascalientes</div>
    </div>
    <div class="badges">
      <span class="badge badge-verde">SIN BURÓ</span>
      <span class="badge badge-cyan">SIN AVAL</span>
      <span class="badge badge-ghost">REGISTRO GRATUITO</span>
    </div>
  </div>
</div>
${bodyContent}
<div class="footer">CMU · Conductores del Mundo S.A.P.I. de C.V.</div>
</body>
</html>`;
}

// ===== Render: Grid (index) =====
function renderGrid(vehicles: PublicVehicle[], baseUrl: string): string {
  const cards = vehicles.map((v) => {
    const name = vehicleName(v);
    const { rows, recaudo } = buildAmort(v.precio);
    const cuotaM3 = rows[2].cuota;
    // Find month where GNV covers full cuota
    const mesGnvCubre = rows.findIndex((r) => r.cuota <= recaudo);
    const mesLabel = mesGnvCubre >= 0 ? `GNV cubre cuota desde mes ${mesGnvCubre + 1}` : "";

    return `
    <a href="/${v.slug}" class="card">
      ${v.destacado ? '<div class="card-tag-popular">Más popular</div>' : ""}
      <div class="card-badge">${statusBadge(v.status)}</div>
      <img class="card-img" src="${v.foto_url || '/vehicles/default.png'}" alt="${name}" loading="lazy">
      <div class="card-body">
        <div class="card-name">${name}</div>
        <div class="card-details">${v.color || "Blanco"} · Kit GNV instalado · Listo para trabajar</div>
        <div class="card-price">${fmt(v.precio)}</div>
        <div class="card-cuota">Cuota desde ${fmt(cuotaM3)}/mes (post-anticipo) · ${mesLabel}</div>
        <div class="card-gnv">⛽ GNV · Recaudo ${fmt(recaudo)}/mes</div>
      </div>
    </a>`;
  }).join("\n");

  const available = vehicles.filter((v) => v.status === "disponible").length;

  const body = `
  <div class="container">
    <div class="section-title">${available} vehículos disponibles · Inventario actualizado</div>
    <div class="grid">${cards}</div>
    <div class="cta-section" style="margin-top:32px">
      <div class="cta-section-title">¿Listo para renovar tu taxi?</div>
      <div class="cta-section-sub">Sin buró de crédito · Sin aval · Registro gratuito</div>
      <a href="https://wa.me/524463293102?text=Hola%2C%20vi%20el%20inventario%20y%20quiero%20informaci%C3%B3n" class="cta cta-wa" style="display:inline-block;width:auto;padding:14px 32px">
        Escríbenos por WhatsApp · 446 329 3102
      </a>
    </div>
  </div>`;

  return htmlShell(
    "Inventario CMU — Renovación de Taxi con GNV",
    ogTags(null, baseUrl),
    body
  );
}

// ===== Render: Individual vehicle ficha =====
function renderFicha(v: PublicVehicle, baseUrl: string): string {
  const name = vehicleName(v);
  const { rows, recaudo } = buildAmort(v.precio);
  const cuotaM1 = rows[0].cuota;
  const cuotaM3 = rows[2].cuota;
  const mesGnvCubre = rows.findIndex((r) => r.cuota <= recaudo);

  // Comparativo gasolina vs GNV
  const kmMes = 5200;
  const precioGas = 22.50;
  const rendGas = 12;
  const precioGNV = 12.99;
  const rendGNV = 16;
  const gastoGas = Math.round((kmMes / rendGas) * precioGas);
  const gastoGNV = Math.round((kmMes / rendGNV) * precioGNV);
  const ahorro = gastoGas - gastoGNV;
  const leqMes = Math.round(kmMes / rendGNV);
  const gastoReal = Math.round((kmMes / rendGNV) * (precioGNV - 11));

  const waText = encodeURIComponent(`Hola, me interesa el ${name} que vi en el inventario`);

  const body = `
  <div class="container">
    <div class="ficha">
      <a href="/" class="back">← Ver todo el inventario</a>
      
      <div class="ficha-hero">
        <img src="${v.foto_url || '/vehicles/default.png'}" alt="${name}">
      </div>

      <div class="ficha-header">
        <div>
          <div class="ficha-name">${name}</div>
          <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
            ${statusBadge(v.status)}
            <span style="font-size:12px;color:var(--muted)">${v.color || "Blanco"} · Kit GNV instalado</span>
          </div>
        </div>
        <div>
          <div class="ficha-price-label">Precio CMU</div>
          <div class="ficha-price">${fmt(v.precio)}</div>
        </div>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="stat-label">Cuota mes 1</div>
          <div class="stat-val" style="color:var(--amber)">${fmt(cuotaM1)}</div>
          <div class="stat-sub">Principal + interés</div>
        </div>
        <div class="stat">
          <div class="stat-label">Cuota mes 3+</div>
          <div class="stat-val" style="color:var(--verde)">${fmt(cuotaM3)}</div>
          <div class="stat-sub">Post-anticipo $50k</div>
        </div>
        <div class="stat">
          <div class="stat-label">GNV cubre desde</div>
          <div class="stat-val" style="color:var(--cyan)">Mes ${mesGnvCubre >= 0 ? mesGnvCubre + 1 : "34+"}</div>
          <div class="stat-sub">Con 400 LEQ/mes</div>
        </div>
      </div>

      <!-- Calculadora interactiva -->
      <div class="comp" id="calcSection">
        <div class="comp-title">Personaliza tu consumo</div>
        <div class="slider-group">
          <div class="slider-label">LEQ/mes (consumo de gas natural)</div>
          <div class="slider-row">
            <input type="range" id="leqSlider" min="200" max="800" step="50" value="400"
              oninput="updateCalc()">
            <span class="slider-val" id="leqVal">400</span>
          </div>
        </div>
        <div id="calcResult"></div>
      </div>

      <!-- Comparativo -->
      <div class="comp">
        <div class="comp-title">Comparativo de gasto mensual en combustible</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px">Base: 5,200 km/mes (200 km/día × 26 días) · Gasolina $22.50/L · GNV $12.99/LEQ</div>
        <div class="comp-grid">
          <div class="comp-box" style="border:2px solid var(--rojo)">
            <div class="comp-box-label" style="color:var(--rojo)">Gasolina</div>
            <div class="comp-box-val" style="color:var(--rojo)">${fmt(gastoGas)}</div>
            <div class="comp-box-sub">${Math.round(kmMes / rendGas)} litros</div>
          </div>
          <div class="comp-box" style="border:2px solid var(--verde)">
            <div class="comp-box-label" style="color:var(--verde)">GNV</div>
            <div class="comp-box-val" style="color:var(--verde)">${fmt(gastoGNV)}</div>
            <div class="comp-box-sub">${leqMes} LEQ</div>
          </div>
          <div class="comp-box" style="border:2px solid var(--cyan);background:rgba(0,174,239,.05)">
            <div class="comp-box-label">Ahorro</div>
            <div class="comp-box-val" style="color:var(--cyan)">${fmt(ahorro)}/mes</div>
            <div class="comp-box-sub">${Math.round((ahorro / gastoGas) * 100)}% menos</div>
          </div>
        </div>
        <div class="comp-detail">
          <strong style="color:var(--verde)">De los $${precioGNV} por LEQ que pagas:</strong><br>
          • <strong>$11.00</strong> abonan a tu cuota CMU (recaudo ~${fmt(recaudo)}/mes con 400 LEQ)<br>
          • <strong>$${(precioGNV - 11).toFixed(2)}</strong> es tu costo real de combustible<br>
          • Tu gasto real: <strong>${fmt(gastoReal)}/mes</strong> — el resto paga tu carro
        </div>
      </div>

      <!-- Timeline -->
      <div class="comp">
        <div class="comp-title">Tu camino con CMU</div>
        <div class="timeline">
          <div class="tl-item"><div class="tl-when">Registro</div><div class="tl-what">Gratis. Sin buró de crédito. Sin aval. Solo tus documentos y tu concesión.</div></div>
          <div class="tl-item"><div class="tl-when">Firma</div><div class="tl-what">Fondo de Garantía inicial: $8,000. Firmas contrato + pagaré de anticipo.</div></div>
          <div class="tl-item"><div class="tl-when">~Día 25</div><div class="tl-what">Recibes tu vehículo con kit GNV instalado (~25 días naturales desde la firma).</div></div>
          <div class="tl-item"><div class="tl-when">Mes 1</div><div class="tl-what">Empiezas a cargar GNV. Tu consumo abona automáticamente a tu cuota.</div></div>
          <div class="tl-item"><div class="tl-when">Semana 8</div><div class="tl-what">Vendes tu unidad actual → anticipo de $50,000 a capital. Cuota baja.</div></div>
          <div class="tl-item"><div class="tl-when">Mes 3+</div><div class="tl-what">Cuota baja a <strong>${fmt(cuotaM3)}/mes</strong>. GNV cubre la mayor parte.</div></div>
          <div class="tl-item"><div class="tl-when">Mes ${mesGnvCubre >= 0 ? mesGnvCubre + 1 : "34"}</div><div class="tl-what"><strong style="color:var(--verde)">GNV cubre tu cuota completa.</strong> $0 de tu bolsillo.</div></div>
          <div class="tl-item"><div class="tl-when">Mes 37</div><div class="tl-what"><strong style="color:var(--cyan)">Vehículo 100% tuyo.</strong> CMU libera reserva de dominio + remanente del Fondo de Garantía.</div></div>
        </div>
      </div>

      <!-- CTA -->
      <a href="https://wa.me/524463293102?text=${waText}" class="cta cta-wa" style="margin-bottom:12px">
        Me interesa este vehículo · WhatsApp
      </a>
      <a href="/" class="cta" style="background:var(--card);border:1px solid rgba(255,255,255,.1)">
        ← Ver todo el inventario
      </a>
    </div>
    
    <div class="cta-section" style="margin-top:32px">
      <div class="cta-section-title">¿Listo para renovar tu taxi?</div>
      <div class="cta-section-sub">Sin buró de crédito · Sin aval · Registro gratuito</div>
      <a href="https://wa.me/524463293102?text=${waText}" class="cta cta-wa" style="display:inline-block;width:auto;padding:14px 32px">
        Escríbenos por WhatsApp · 446 329 3102
      </a>
    </div>
  </div>

  <script>
  const PRECIO = ${v.precio};
  const TASA_M = 0.299/12, N = 36, ANT = 50000, FG_I = 8000, FG_M = 334;
  
  function updateCalc() {
    const leq = parseInt(document.getElementById('leqSlider').value);
    document.getElementById('leqVal').textContent = leq;
    const tarifa = 11;
    const recaudo = leq * tarifa;
    
    let saldo = PRECIO;
    const capitalFijo = PRECIO / N;
    let cuotaM3 = 0, mesGnv = -1;
    
    for (let m = 1; m <= N; m++) {
      if (m === 3) saldo -= ANT;
      const interes = saldo * TASA_M;
      const cuota = capitalFijo + interes;
      if (m === 3) cuotaM3 = Math.round(cuota);
      if (mesGnv < 0 && cuota <= recaudo) mesGnv = m;
      saldo -= capitalFijo;
    }
    
    const diff = Math.max(0, cuotaM3 - recaudo);
    
    document.getElementById('calcResult').innerHTML = 
      '<div class="stats" style="margin-top:12px">' +
      '<div class="stat"><div class="stat-label">Recaudo GNV</div><div class="stat-val" style="color:var(--verde)">$' + recaudo.toLocaleString('es-MX') + '</div><div class="stat-sub">' + leq + ' LEQ × $11</div></div>' +
      '<div class="stat"><div class="stat-label">De tu bolsillo (mes 3+)</div><div class="stat-val" style="color:' + (diff > 0 ? 'var(--amber)' : 'var(--verde)') + '">$' + (diff + FG_M).toLocaleString('es-MX') + '</div><div class="stat-sub">Diferencial + FG $334</div></div>' +
      '<div class="stat"><div class="stat-label">GNV cubre desde</div><div class="stat-val" style="color:var(--cyan)">' + (mesGnv > 0 ? 'Mes ' + mesGnv : 'Mes 36+') + '</div><div class="stat-sub">$0 de tu bolsillo</div></div>' +
      '</div>';
  }
  updateCalc();
  </script>`;

  return htmlShell(
    `${name} — ${fmt(v.precio)} | CMU`,
    ogTags(v, baseUrl),
    body
  );
}

// ===== Router =====
export function createCatalogoRouter(): Router {
  const router = Router();

  // JSON API
  router.get("/api/inventario/public", async (_req: Request, res: Response) => {
    try {
      const vehicles = await getPublicInventory();
      res.json({ vehicles, count: vehicles.length });
    } catch (err) {
      console.error("Error fetching public inventory:", err);
      res.status(500).json({ error: "Error loading inventory" });
    }
  });

  router.get("/api/inventario/public/:slug", async (req: Request, res: Response) => {
    try {
      const v = await getPublicVehicleBySlug(req.params.slug as string);
      if (!v) return res.status(404).json({ error: "Vehicle not found" });
      res.json(v);
    } catch (err) {
      console.error("Error fetching vehicle:", err);
      res.status(500).json({ error: "Error loading vehicle" });
    }
  });

  return router;
}

// ===== SSR HTML handler (hostname-based) =====
export function catalogoHtmlHandler(baseUrl: string) {
  return async (req: Request, res: Response) => {
    const path = req.path;

    // Static files and API routes are handled by other middleware
    if (path.startsWith("/vehicles/") || path.startsWith("/api/") || path.includes(".")) {
      return;
    }

    try {
      if (path === "/" || path === "") {
        const vehicles = await getPublicInventory();
        const html = renderGrid(vehicles, baseUrl);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=300"); // 5 min cache
        return res.send(html);
      }

      // Individual vehicle: /:slug
      const slug = path.replace(/^\//, "").replace(/\/$/, "");
      if (slug && !slug.includes("/") && !slug.includes(".")) {
        const v = await getPublicVehicleBySlug(slug);
        if (v) {
          const html = renderFicha(v, baseUrl);
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "public, max-age=300");
          return res.send(html);
        }
      }

      // 404
      res.status(404).send(htmlShell("No encontrado", "", '<div class="container"><h2>Vehículo no encontrado</h2><a href="/" class="back">← Ver inventario</a></div>'));
    } catch (err) {
      console.error("Catalogo SSR error:", err);
      res.status(500).send("Error interno");
    }
  };
}
