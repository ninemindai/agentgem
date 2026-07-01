// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Browse-only "shared" gem catalog. Manifest metadata only (no archive bytes).
import { createHash } from "node:crypto";
import { sql, desc } from "drizzle-orm";
import { verify } from "@agentgem/model";
import { canonicalJSON } from "@agentgem/insight";
import type { AppDb } from "./schema.js";
import { catalogGems, producers, accountBindings } from "./schema.js";

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
  const rows = await db.select().from(catalogGems).orderBy(desc(catalogGems.createdAtMs));
  return rows.map((r) => ({
    gemKey: r.gemKey, version: r.version, publishedBy: r.publishedBy,
    author: r.author ?? undefined, description: r.description ?? undefined,
    tags: r.tags ?? undefined, artifactKinds: r.artifactKinds ?? undefined,
    type: r.type ?? undefined, grade: r.grade ?? undefined, createdAtMs: r.createdAtMs,
  }));
}

export interface CatalogManifest {
  gemKey: string; version: string; author?: string; description?: string;
  tags?: string[]; artifactKinds?: string[]; type?: string; grade?: number;
}
export interface ShareRequest { manifest: CatalogManifest; pubkey: string; signedAt: number; signature: string }
export type ShareResult =
  | { shared: true; publishedBy: string; gemKey: string; version: string }
  | { shared: false; rejected: "bad-signature" | "stale" | "not-connected" };

const FRESHNESS_MS = 300_000;
// Grade is a 1..3 floor. Exported so the read path (mapDbToGems) can re-clamp defensively —
// an out-of-band DB write with an out-of-range grade must not 500 the public catalog via the
// response schema's min(1).max(3). NaN-safe: a non-numeric grade collapses to undefined.
export const clampGrade = (g?: number): number | undefined =>
  g === undefined || Number.isNaN(g) ? undefined : Math.max(1, Math.min(3, Math.trunc(g)));

// Sign over a hash of the manifest so the canonical (loggable) payload stays compact and stable.
export function catalogSigningPayload(m: CatalogManifest, pubkey: string, signedAt: number): string {
  const manifestHash = createHash("sha256").update(canonicalJSON(m)).digest("hex");
  return canonicalJSON({ pubkey, signedAt, manifestHash });
}

// publishedBy is ALWAYS server-derived from the account_bindings lookup below — never
// from req.manifest.author or any other client-supplied field. The signature only proves
// producer-key possession; the binding is what proves that key maps to a verified GitHub
// login, so it is the sole source of truth for attribution. Mirrors recordBinding (binding.ts).
export async function recordCatalogShare(db: AppDb, req: ShareRequest, now: number = Date.now()): Promise<ShareResult> {
  if (!verify(req.pubkey, catalogSigningPayload(req.manifest, req.pubkey, req.signedAt), req.signature)) {
    return { shared: false, rejected: "bad-signature" };
  }
  if (!Number.isFinite(req.signedAt) || Math.abs(now - req.signedAt) > FRESHNESS_MS) {
    return { shared: false, rejected: "stale" };
  }
  // Bootstrap: register the producer so a first-time desktop can share (mirrors ingest's implicit
  // producer creation). No-op if it already exists.
  await db.insert(producers).values({ pubkey: req.pubkey }).onConflictDoNothing();
  const bind = await db.select().from(accountBindings).where(sql`pubkey = ${req.pubkey}`);
  const login = bind[0]?.accountLogin;
  if (!login) return { shared: false, rejected: "not-connected" };
  const m = req.manifest;
  await upsertCatalogGem(db, {
    gemKey: m.gemKey, version: m.version, publishedBy: login,
    author: m.author, description: m.description, tags: m.tags, artifactKinds: m.artifactKinds,
    type: m.type, grade: clampGrade(m.grade), createdAtMs: now,
  });
  return { shared: true, publishedBy: login, gemKey: m.gemKey, version: m.version };
}
