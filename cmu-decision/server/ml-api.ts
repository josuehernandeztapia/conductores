/**
 * MercadoLibre API Integration — Token Manager + Search
 * 
 * Uses OAuth2 authorization_code flow:
 * 1. User authorizes at /api/ml/authorize → ML redirects to /api/ml-callback with code
 * 2. Callback exchanges code for access_token + refresh_token, saves to DB
 * 3. Token auto-refreshes before expiry using refresh_token
 * 4. searchML() uses token to query /sites/MLM/search
 */

import { neon } from "@neondatabase/serverless";

const ML_CLIENT_ID = process.env.ML_CLIENT_ID || "";
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || "";
const ML_REDIRECT_URI = "https://cmu-originacion.fly.dev/api/ml-callback";
const ML_TOKEN_URL = "https://api.mercadolibre.com/oauth/token";
const ML_SEARCH_URL = "https://api.mercadolibre.com/sites/MLM/search";

// Category for autos/vehicles in MercadoLibre Mexico
const ML_CATEGORY_AUTOS = "MLM1744";

// In-memory cache
let cachedToken: { access_token: string; expires_at: number } | null = null;

function getDb() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("No DATABASE_URL");
  return neon(dbUrl);
}

// ===== Token Management =====

/** Get a valid access token (from cache, DB, or refresh) */
export async function getMLToken(): Promise<string | null> {
  // 1. Check memory cache (with 5-min buffer before expiry)
  if (cachedToken && Date.now() < cachedToken.expires_at - 5 * 60 * 1000) {
    return cachedToken.access_token;
  }

  // 2. Check DB
  const sql = getDb();
  const rows = await sql`SELECT access_token, refresh_token, expires_at FROM ml_tokens ORDER BY id DESC LIMIT 1`;
  if (rows.length === 0) {
    console.log("[ML-API] No tokens in DB — needs authorization");
    return null;
  }

  const row = rows[0];
  const expiresAt = new Date(row.expires_at).getTime();

  // 3. If token still valid, cache and return
  if (Date.now() < expiresAt - 5 * 60 * 1000) {
    cachedToken = { access_token: row.access_token, expires_at: expiresAt };
    console.log("[ML-API] Token loaded from DB, valid until", new Date(expiresAt).toISOString());
    return row.access_token;
  }

  // 4. Token expired — refresh it
  console.log("[ML-API] Token expired, refreshing...");
  return await refreshToken(row.refresh_token);
}

/** Exchange authorization code for tokens */
export async function exchangeCode(code: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(ML_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        code,
        redirect_uri: ML_REDIRECT_URI,
      }),
    });

    const data = await res.json();
    console.log("[ML-API] Exchange code response:", res.status, data.error || "OK");

    if (!data.access_token) {
      return { success: false, error: data.message || data.error || "No access_token in response" };
    }

    await saveTokens(data.access_token, data.refresh_token, data.expires_in, data.user_id);
    return { success: true };
  } catch (e: any) {
    console.error("[ML-API] Exchange code error:", e.message);
    return { success: false, error: e.message };
  }
}

/** Refresh an expired token */
async function refreshToken(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch(ML_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        refresh_token: refreshToken,
      }),
    });

    const data = await res.json();
    console.log("[ML-API] Refresh token response:", res.status, data.error || "OK");

    if (!data.access_token) {
      console.error("[ML-API] Refresh failed:", data.message || data.error);
      cachedToken = null;
      return null;
    }

    await saveTokens(data.access_token, data.refresh_token, data.expires_in, data.user_id);
    return data.access_token;
  } catch (e: any) {
    console.error("[ML-API] Refresh error:", e.message);
    return null;
  }
}

/** Save tokens to DB and memory cache */
async function saveTokens(accessToken: string, refreshTok: string, expiresIn: number, userId?: string) {
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  cachedToken = { access_token: accessToken, expires_at: expiresAt.getTime() };

  const sql = getDb();
  // Upsert: delete old, insert new
  await sql`DELETE FROM ml_tokens`;
  await sql`INSERT INTO ml_tokens (access_token, refresh_token, expires_at, user_id, updated_at) 
            VALUES (${accessToken}, ${refreshTok}, ${expiresAt.toISOString()}, ${userId || null}, NOW())`;
  console.log(`[ML-API] Tokens saved. Expires: ${expiresAt.toISOString()}`);
}

// ===== Search =====

export type MLSearchResult = {
  prices: { price: number; title: string; year: string | null; km: string | null; source: string }[];
  total: number;
  error?: string;
};

/** Search MercadoLibre for vehicles */
export async function searchML(brand: string, model: string, year: number): Promise<MLSearchResult> {
  const token = await getMLToken();
  if (!token) {
    return { prices: [], total: 0, error: "No ML token — needs authorization at /api/ml/authorize" };
  }

  try {
    const query = `${brand} ${model} ${year}`.trim();
    const url = `${ML_SEARCH_URL}?q=${encodeURIComponent(query)}&category=${ML_CATEGORY_AUTOS}&limit=50`;
    
    console.log(`[ML-API] Search: ${query}`);
    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 401) {
      // Token invalid — clear cache and try refresh once
      console.log("[ML-API] 401 — clearing token cache");
      cachedToken = null;
      const newToken = await getMLToken();
      if (newToken) {
        const retry = await fetch(url, {
          headers: { "Authorization": `Bearer ${newToken}` },
          signal: AbortSignal.timeout(15000),
        });
        if (retry.ok) {
          const data = await retry.json();
          return parseSearchResults(data, year);
        }
      }
      return { prices: [], total: 0, error: "ML token expired and refresh failed" };
    }

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[ML-API] Search error ${res.status}:`, errBody.substring(0, 200));
      return { prices: [], total: 0, error: `ML API ${res.status}` };
    }

    const data = await res.json();
    return parseSearchResults(data, year);
  } catch (e: any) {
    console.error("[ML-API] Search error:", e.message);
    return { prices: [], total: 0, error: e.message };
  }
}

/** Parse ML search results, filtering by exact year */
function parseSearchResults(data: any, targetYear: number): MLSearchResult {
  const results = data.results || [];
  const total = data.paging?.total || 0;
  console.log(`[ML-API] Got ${results.length} results (${total} total)`);

  const prices: MLSearchResult["prices"] = [];

  for (const item of results) {
    if (!item.price || item.price < 50000 || item.price > 600000) continue;

    // Extract year from attributes
    const yearAttr = item.attributes?.find((a: any) => a.id === "VEHICLE_YEAR");
    const itemYear = yearAttr?.value_name || null;
    const kmAttr = item.attributes?.find((a: any) => a.id === "KILOMETERS");
    const km = kmAttr?.value_name || null;

    // Filter by exact year if available
    if (itemYear && parseInt(itemYear) !== targetYear) continue;

    prices.push({
      price: item.price,
      title: item.title || "",
      year: itemYear,
      km,
      source: "MercadoLibre",
    });
  }

  console.log(`[ML-API] After year filter (${targetYear}): ${prices.length} prices`);
  return { prices, total };
}

/** Get the authorization URL for ML OAuth */
export function getMLAuthUrl(): string {
  return `https://auth.mercadolibre.com.mx/authorization?response_type=code&client_id=${ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}`;
}

/** Check if ML API is configured */
export function isMLConfigured(): boolean {
  return !!(ML_CLIENT_ID && ML_CLIENT_SECRET);
}
