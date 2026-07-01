// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Browse-only "shared" gem catalog. Manifest metadata only (no archive bytes).
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { catalogGems } from "./schema.js";

export interface CatalogRow {
  gemKey: string; version: string; publishedBy: string;
  author?: string; description?: string; tags?: string[]; artifactKinds?: string[];
  type?: string; grade?: number; createdAtMs: number;
}

export async function upsertCatalogGem(db: AppDb, row: CatalogRow): Promise<void> {
  await db.insert(catalogGems).values({
    gemKey: row.gemKey, version: row.version, publishedBy: row.publishedBy,
    author: row.author ?? null, description: row.description ?? null,
    tags: row.tags ?? null, artifactKinds: row.artifactKinds ?? null,
    type: row.type ?? null, grade: row.grade ?? null, createdAtMs: row.createdAtMs,
  }).onConflictDoUpdate({
    target: [catalogGems.gemKey, catalogGems.version],
    set: {
      publishedBy: row.publishedBy, author: row.author ?? null, description: row.description ?? null,
      tags: row.tags ?? null, artifactKinds: row.artifactKinds ?? null, type: row.type ?? null,
      grade: row.grade ?? null, createdAtMs: row.createdAtMs,
    },
  });
}

export async function listCatalogGems(db: AppDb): Promise<CatalogRow[]> {
  const rows = await db.select().from(catalogGems).orderBy(sql`created_at_ms desc`);
  return rows.map((r) => ({
    gemKey: r.gemKey, version: r.version, publishedBy: r.publishedBy,
    author: r.author ?? undefined, description: r.description ?? undefined,
    tags: r.tags ?? undefined, artifactKinds: r.artifactKinds ?? undefined,
    type: r.type ?? undefined, grade: r.grade ?? undefined, createdAtMs: r.createdAtMs,
  }));
}
