// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Chooses the aggregator's database: hosted Postgres when DATABASE_URL is set, otherwise an
// embedded pglite instance so the full gated aggregator runs locally with no external Postgres.
// pglite data is in-memory/ephemeral — for dev + validation, not production.
import { schema, ensureSchema, type AppDb } from "./schema.js";

export async function resolveAggregatorDb(): Promise<{ db: AppDb; onStop: () => Promise<void>; mode: "postgres" | "pglite" }> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({ connectionString: url });
    const db = drizzle(pool, { schema }) as unknown as AppDb;
    await ensureSchema(db);
    return { db, onStop: () => pool.end(), mode: "postgres" };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const pg = new PGlite();
  const db = drizzle(pg, { schema }) as unknown as AppDb;
  await ensureSchema(db);
  return { db, onStop: () => pg.close(), mode: "pglite" };
}
