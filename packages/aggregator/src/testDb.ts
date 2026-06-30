// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { schema, ensureSchema, type AppDb } from "./schema.js";

export async function makeTestDb(): Promise<AppDb> {
  const db = drizzle(new PGlite(), { schema }) as unknown as AppDb;
  await ensureSchema(db);
  return db;
}
