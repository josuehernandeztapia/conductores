/**
 * Neon PostgreSQL connection via @neondatabase/serverless + Drizzle ORM.
 * DATABASE_URL must be set as environment variable.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "@shared/schema";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn("[DB] DATABASE_URL not set — database operations will fail");
}

const _neonSql = databaseUrl ? neon(databaseUrl) : null;
export const db = _neonSql ? drizzle(_neonSql, { schema }) : null;
export const sql = _neonSql;

export function getDb() {
  if (!db) {
    throw new Error("Database not configured. Set DATABASE_URL environment variable.");
  }
  return db;
}
