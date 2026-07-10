// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Browse-only "shared" gem catalog. Manifest metadata only (no archive bytes).
import { createHash } from "node:crypto";
import { sql, desc, and, eq } from "drizzle-orm";
import { verify } from "@agentgem/model";
import { canonicalJSON } from "@agentgem/insight";
import type { AppDb } from "./schema.js";
import { catalogGems, gemArchives, producers, accountBindings, accounts } from "./schema.js";

export interface GemArtifactRef { name: string; type: string }
export interface CatalogRow {
  gemKey: string; version: string; publishedBy: string;
  author?: string; description?: string; tags?: string[]; artifactKinds?: string[];
  type?: string; grade?: number; createdAtMs: number;
  artifacts?: GemArtifactRef[];
  installable?: boolean; // derived: a gem_archives row exists (read path only)
  ownerAccountId?: string | null;
}

export async function upsertCatalogGem(db: AppDb, row: CatalogRow): Promise<void> {
  await db.insert(catalogGems).values({
    gemKey: row.gemKey, version: row.version, publishedBy: row.publishedBy,
    author: row.author ?? null, description: row.description ?? null,
    tags: row.tags ?? null, artifactKinds: row.artifactKinds ?? null,
    type: row.type ?? null, grade: row.grade ?? null, artifacts: row.artifacts ?? null,
    createdAtMs: row.createdAtMs, ownerAccountId: row.ownerAccountId ?? null,
  }).onConflictDoUpdate({
    target: [catalogGems.gemKey, catalogGems.version],
    set: {
      publishedBy: row.publishedBy, author: row.author ?? null, description: row.description ?? null,
      tags: row.tags ?? null, artifactKinds: row.artifactKinds ?? null, type: row.type ?? null,
      grade: row.grade ?? null, artifacts: row.artifacts ?? null, createdAtMs: row.createdAtMs,
      ownerAccountId: row.ownerAccountId ?? null,
    },
  });
}

export async function listCatalogGems(db: AppDb): Promise<CatalogRow[]> {
  // Left-join gem_archives so `installable` reflects whether the content was uploaded.
  const rows = await db.select({
    gemKey: catalogGems.gemKey, version: catalogGems.version, publishedBy: catalogGems.publishedBy,
    author: catalogGems.author, description: catalogGems.description, tags: catalogGems.tags,
    artifactKinds: catalogGems.artifactKinds, type: catalogGems.type, grade: catalogGems.grade,
    artifacts: catalogGems.artifacts, createdAtMs: catalogGems.createdAtMs, archiveKey: gemArchives.gemKey,
  }).from(catalogGems)
    .leftJoin(gemArchives, and(eq(catalogGems.gemKey, gemArchives.gemKey), eq(catalogGems.version, gemArchives.version)))
    .orderBy(desc(catalogGems.createdAtMs));
  return rows.map((r) => ({
    gemKey: r.gemKey, version: r.version, publishedBy: r.publishedBy,
    author: r.author ?? undefined, description: r.description ?? undefined,
    tags: r.tags ?? undefined, artifactKinds: r.artifactKinds ?? undefined,
    type: r.type ?? undefined, grade: r.grade ?? undefined, artifacts: r.artifacts ?? undefined,
    createdAtMs: r.createdAtMs, installable: r.archiveKey != null,
  }));
}

export async function upsertGemArchive(db: AppDb, a: { gemKey: string; version: string; bytes: Uint8Array; digest: string; createdAtMs: number; ownerAccountId?: string }): Promise<void> {
  await db.insert(gemArchives).values({ gemKey: a.gemKey, version: a.version, bytes: a.bytes, size: a.bytes.length, digest: a.digest, createdAtMs: a.createdAtMs, ownerAccountId: a.ownerAccountId ?? null })
    .onConflictDoUpdate({ target: [gemArchives.gemKey, gemArchives.version], set: { bytes: a.bytes, size: a.bytes.length, digest: a.digest, createdAtMs: a.createdAtMs, ownerAccountId: a.ownerAccountId ?? null } });
}

export async function getGemArchive(db: AppDb, gemKey: string, version: string): Promise<{ bytes: Uint8Array; digest: string } | null> {
  const r = (await db.select({ bytes: gemArchives.bytes, digest: gemArchives.digest }).from(gemArchives)
    .where(and(eq(gemArchives.gemKey, gemKey), eq(gemArchives.version, version))).limit(1))[0];
  return r ? { bytes: r.bytes, digest: r.digest } : null;
}

// The most recently PUBLISHED version of a gem. Ordering is by publish time, not semver: "latest"
// here means "what the publisher last shipped", which is what a bare /games/<key> URL should serve.
// Unlisted (scope-less) keys have no catalog row and therefore no latest — callers pass an explicit
// version for those.
export async function latestGemVersion(db: AppDb, gemKey: string): Promise<string | null> {
  const rows = await db.select({ version: catalogGems.version })
    .from(catalogGems)
    .where(eq(catalogGems.gemKey, gemKey))
    .orderBy(desc(catalogGems.createdAtMs))
    .limit(1);
  return rows[0]?.version ?? null;
}

export async function catalogGemExists(db: AppDb, gemKey: string, version: string): Promise<boolean> {
  const r = (await db.select({ gemKey: catalogGems.gemKey }).from(catalogGems)
    .where(and(eq(catalogGems.gemKey, gemKey), eq(catalogGems.version, version))).limit(1))[0];
  return r != null;
}

export type DeleteGemResult = "deleted" | "not-found" | "forbidden";

// Owner-only unpublish. Ownership is the accounts.id uuid — NEVER the `published_by` string,
// which is a denormalized display value with no uniqueness constraint anywhere in the schema.
// A row with owner_account_id = NULL (an unresolvable backfill; see backfillGemOwners) is owned
// by NOBODY and cannot be unpublished by anyone. Do not add a string-compare fallback for it:
// that is the "" === "" hole this re-key exists to close.
export async function deleteCatalogGem(db: AppDb, gemKey: string, version: string, ownerAccountId: string): Promise<DeleteGemResult> {
  const row = (await db.select({ ownerAccountId: catalogGems.ownerAccountId }).from(catalogGems)
    .where(and(eq(catalogGems.gemKey, gemKey), eq(catalogGems.version, version))).limit(1))[0];
  if (!row) return "not-found";
  if (row.ownerAccountId === null || row.ownerAccountId !== ownerAccountId) return "forbidden";
  await db.delete(gemArchives).where(and(eq(gemArchives.gemKey, gemKey), eq(gemArchives.version, version)));
  await db.delete(catalogGems).where(and(eq(catalogGems.gemKey, gemKey), eq(catalogGems.version, version)));
  return "deleted";
}

// Owner-only revoke of an UNLISTED share archive (no catalog_gems row exists for it). Mirrors
// deleteCatalogGem's rule exactly: NULL owner is owned by nobody; compare the accounts.id uuid,
// never a string. Deletes only the gem_archives row.
export async function deleteGemArchiveOwned(db: AppDb, gemKey: string, ownerAccountId: string): Promise<DeleteGemResult> {
  // Delete only rows this account owns (a NULL owner never matches a uuid), then classify what
  // happened. This is fully correct regardless of how many versions/owners share the key: no
  // nondeterministic pre-check, and a co-key row owned by someone else is never touched.
  const deleted = await db.delete(gemArchives)
    .where(and(eq(gemArchives.gemKey, gemKey), eq(gemArchives.ownerAccountId, ownerAccountId)))
    .returning({ gemKey: gemArchives.gemKey });
  if (deleted.length > 0) return "deleted";
  const exists = (await db.select({ gemKey: gemArchives.gemKey }).from(gemArchives)
    .where(eq(gemArchives.gemKey, gemKey)).limit(1))[0];
  return exists ? "forbidden" : "not-found";
}

// The version of a gem_archives row that has NO catalog_gems row — i.e. an unlisted share. Used by
// game-meta to resolve /games/<shareId> (a scope-less key has no catalog "latest"). Returns null
// for a published gem (its version comes from latestGemVersion) or an absent key.
export async function archiveOnlyVersion(db: AppDb, gemKey: string): Promise<string | null> {
  const listed = await catalogGemExists2(db, gemKey);
  if (listed) return null;
  const row = (await db.select({ version: gemArchives.version }).from(gemArchives)
    .where(eq(gemArchives.gemKey, gemKey)).orderBy(desc(gemArchives.createdAtMs)).limit(1))[0];
  return row?.version ?? null;
}

// True if ANY catalog_gems row exists for this key (any version). Distinct from catalogGemExists,
// which needs a specific version.
async function catalogGemExists2(db: AppDb, gemKey: string): Promise<boolean> {
  const r = (await db.select({ gemKey: catalogGems.gemKey }).from(catalogGems).where(eq(catalogGems.gemKey, gemKey)).limit(1))[0];
  return r != null;
}

export interface CatalogManifest {
  gemKey: string; version: string; author?: string; description?: string;
  tags?: string[]; artifactKinds?: string[]; type?: string; grade?: number;
  // Set by the archive-publish path: the per-artifact preview list and the archive's content
  // digest. Both are inside the signed manifest, so the signature binds the publish to this archive.
  artifacts?: GemArtifactRef[]; gemDigest?: string;
}
export interface ShareRequest { manifest: CatalogManifest; pubkey: string; signedAt: number; signature: string }
export type ShareResult =
  | { shared: true; publishedBy: string; gemKey: string; version: string }
  | { shared: false; rejected: "bad-signature" | "stale" | "not-connected" | "conflict" | "invalid-key" };

const FRESHNESS_MS = 300_000;

export type SignedAccount =
  | { ok: true; accountId: string; login: string }
  | { ok: false; rejected: "bad-signature" | "stale" | "not-connected" };

// The account-resolution chain shared by every signed WRITE: prove key possession over `payload`,
// check freshness, then resolve the producer key to its authorizing accounts.id (== "user".id) via
// the binding. Callers pass whatever canonical payload their route signs (a manifest hash for
// publish/mint, the shareId for revoke). Fail-closed: an unbound or unresolvable key owns nothing.
export async function resolveSignedAccount(
  db: AppDb,
  args: { pubkey: string; payload: string; signedAt: number; signature: string },
  now: number = Date.now(),
): Promise<SignedAccount> {
  if (!verify(args.pubkey, args.payload, args.signature)) return { ok: false, rejected: "bad-signature" };
  if (!Number.isFinite(args.signedAt) || Math.abs(now - args.signedAt) > FRESHNESS_MS) return { ok: false, rejected: "stale" };
  await db.insert(producers).values({ pubkey: args.pubkey }).onConflictDoNothing();
  const bind = (await db.select().from(accountBindings).where(sql`pubkey = ${args.pubkey}`))[0];
  if (!bind) return { ok: false, rejected: "not-connected" };
  const acct = (await db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.provider, bind.provider), eq(accounts.providerAccountId, bind.accountId))).limit(1))[0];
  if (!acct) return { ok: false, rejected: "not-connected" };
  return { ok: true, accountId: acct.id, login: bind.accountLogin };
}

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
  const who = await resolveSignedAccount(db, {
    pubkey: req.pubkey, payload: catalogSigningPayload(req.manifest, req.pubkey, req.signedAt),
    signedAt: req.signedAt, signature: req.signature,
  }, now);
  if (!who.ok) return { shared: false, rejected: who.rejected };
  // Rule 1 (entity-address scheme): a published gem key is scope/name and ALWAYS contains "/".
  // A slash-less key is an UNLISTED share id (genShareId, base62). Refusing it here is what keeps
  // publish-gem from overwriting/listing/orphaning a share via the shared gem_archives table.
  if (!req.manifest.gemKey.includes("/")) return { shared: false, rejected: "invalid-key" };
  const m = req.manifest;
  // Ownership guard: (re)publishing a (gemKey, version) is allowed only when it is unclaimed or
  // already owned by THIS account. A row owned by a different account — or by nobody (null owner,
  // an orphaned backfill) — is a supply-chain takeover attempt (sign any archive for someone else's
  // key/version and overwrite their catalog row + archive bytes). Mirrors deleteCatalogGem's check.
  // Note: this fully closes the deliberate overwrite of an existing gem; a dead-heat first-publish of
  // the same brand-new key by two different accounts is a benign namespace race, not a takeover.
  const existing = (await db.select({ ownerAccountId: catalogGems.ownerAccountId }).from(catalogGems)
    .where(and(eq(catalogGems.gemKey, m.gemKey), eq(catalogGems.version, m.version))).limit(1))[0];
  if (existing && existing.ownerAccountId !== who.accountId) return { shared: false, rejected: "conflict" };
  await upsertCatalogGem(db, {
    gemKey: m.gemKey, version: m.version, publishedBy: who.login, ownerAccountId: who.accountId,
    author: m.author, description: m.description, tags: m.tags, artifactKinds: m.artifactKinds,
    type: m.type, grade: clampGrade(m.grade), artifacts: m.artifacts, createdAtMs: now,
  });
  return { shared: true, publishedBy: who.login, gemKey: m.gemKey, version: m.version };
}
