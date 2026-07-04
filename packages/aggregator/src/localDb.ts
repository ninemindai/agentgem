// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Chooses the aggregator's database: hosted Postgres when DATABASE_URL is set, otherwise an
// embedded pglite instance so the full gated aggregator runs locally with no external Postgres.
// pglite data is in-memory/ephemeral — for dev + validation, not production.
import { schema, ensureSchema, type AppDb } from "./schema.js";
import type { PGlite } from "@electric-sql/pglite";   // type-only: erased, never loads the WASM module

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
  // Local pglite: defer the ~850 MB WASM Postgres (and its schema DDL) until the
  // first query, so a session that never opens an aggregator / marketplace /
  // trust / share route never pays for it. drizzle(client) is cheap to build (the
  // driver only calls client.query()/transaction() per statement), so wrapping a
  // thin lazy client is enough; ensureSchema runs once, on the freshly-created
  // instance, right before the first real query.
  const { drizzle } = await import("drizzle-orm/pglite");
  const lazy = lazyPgliteClient(async (pg) => {
    await ensureSchema(drizzle(pg, { schema }) as unknown as AppDb);
  });
  const db = drizzle(lazy as unknown as PGlite, { schema }) as unknown as AppDb;
  return { db, onStop: () => lazy.close(), mode: "pglite" };
}

// A PGlite client that instantiates the WASM instance (running `init` once) on
// first use, then delegates. drizzle-orm/pglite only calls query() and
// transaction() per statement and close() on teardown, so those are all we wrap.
// The boot promise is memoized, so concurrent first-queries share one instance
// and ensureSchema runs exactly once.
function lazyPgliteClient(init: (pg: PGlite) => Promise<void>) {
  let ready: Promise<PGlite> | null = null;
  const boot = (): Promise<PGlite> =>
    (ready ??= (async () => {
      const { PGlite } = await import("@electric-sql/pglite");
      const pg = new PGlite();
      await init(pg);
      return pg;
    })());
  return {
    query: async (q: any, params?: any, opts?: any) => (await boot()).query(q, params, opts),
    transaction: async (fn: any) => (await boot()).transaction(fn),
    close: async () => { if (ready) await (await ready).close(); },
  };
}
