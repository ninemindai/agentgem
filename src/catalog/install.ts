// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Catalog owner endpoints (raw express, like stars/reviews install.ts): reachable cross-site, own
// credentialed CORS, originGuard-exempt (its prefix is allowlisted in originGuard.ts). DELETE is authed
// (session cookie → 401) and owner-gated: the session's accounts.id uuid must equal the gem's
// owner_account_id (403 otherwise; see deleteCatalogGem). CSRF on the write is stopped by the
// SameSite=Lax session cookie + the 401, NOT by CORS. Unpublish is a hard delete of the catalog row +
// archive bytes (visibility scope is a separate, later feature).
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { resolveSession, deleteCatalogGem, listCatalogGemsForOwner, latestGemVersion, getGemArchive, catalogGemForViewer, accountCanAccessGem } from "@agentgem/aggregator";
import { importGem } from "@agentgem/distribute";
import { cors, preflight, type Req, type Res, type ExpressApp } from "../publicCors.js";

export interface CatalogDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[] }

// Ownership is the accounts.id uuid, never the login string (see deleteCatalogGem).
async function sessionAccountId(deps: CatalogDeps, req: Req): Promise<string | null> {
  const who = await resolveSession(deps.auth, req.headers);
  return who?.accountId ?? null;
}

export function unpublishHandler(deps: CatalogDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, DELETE, OPTIONS"); return; }
    const accountId = await sessionAccountId(deps, req);
    if (!accountId) { res.status(401).json({ error: "sign in required" }); return; }
    const key = String((req.query.key as string | undefined) ?? "");
    const version = String((req.query.version as string | undefined) ?? "");
    if (!key || !version) { res.status(400).json({ error: "key and version required" }); return; }
    const result = await deleteCatalogGem(deps.db, key, version, accountId);
    if (result === "not-found") { res.status(404).json({ error: "gem not found" }); return; }
    if (result === "forbidden") { res.status(403).json({ error: "not your gem" }); return; }
    res.json({ deleted: true, key, version });
  };
}

// The owner's own "My apps" view: every gem they own, across all visibilities (private included).
export function myGemsHandler(deps: CatalogDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, DELETE, OPTIONS"); return; }
    const accountId = await sessionAccountId(deps, req);
    if (!accountId) { res.status(401).json({ error: "sign in required" }); return; }
    const rows = await listCatalogGemsForOwner(deps.db, accountId);
    res.json({
      gems: rows.map((g) => ({
        key: g.gemKey, version: g.version, description: g.description ?? "",
        artifactKinds: g.artifactKinds ?? [], visibility: g.visibility ?? "public", installable: g.installable ?? false,
        createdAtMs: g.createdAtMs, updatedAtMs: g.updatedAtMs ?? g.createdAtMs,
      })),
    });
  };
}

// Access-gated game-meta resolve (mirrors AggregatorController.gameMeta's extraction, but gated to
// accountCanAccessGem instead of public visibility: the owner, or a member of a group the gem is
// shared with). A caller with no access gets the SAME 404 as an unknown key — no existence leak.
export function ownerGameMetaHandler(deps: CatalogDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, DELETE, OPTIONS"); return; }
    const accountId = await sessionAccountId(deps, req);
    if (!accountId) { res.status(401).json({ error: "sign in required" }); return; }
    const key = String((req.query.key as string | undefined) ?? "");
    const version = key ? await latestGemVersion(deps.db, key) : null;
    if (!key || !version) { res.status(404).json({ error: "gem not found" }); return; }
    if (!(await accountCanAccessGem(deps.db, key, version, accountId))) { res.status(404).json({ error: "gem not found" }); return; }
    const a = await getGemArchive(deps.db, key, version);
    if (!a) { res.status(404).json({ error: "gem not found" }); return; }
    const { gem } = importGem(Buffer.from(a.bytes));
    const game = gem.artifacts.find((x) => x.type === "game") as { title?: unknown; genre?: unknown } | undefined;
    if (!game || typeof game.title !== "string") { res.status(404).json({ error: "this gem has no game to play" }); return; }
    res.json({ title: game.title, genre: game.genre, version });
  };
}

// Access-gated game-html (the sealed play HTML). Same no-leak 404 rule as ownerGameMetaHandler.
export function ownerGameHtmlHandler(deps: CatalogDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, DELETE, OPTIONS"); return; }
    const accountId = await sessionAccountId(deps, req);
    if (!accountId) { res.status(401).json({ error: "sign in required" }); return; }
    const key = String((req.query.key as string | undefined) ?? "");
    const version = String((req.query.version as string | undefined) ?? "");
    if (!key || !version) { res.status(404).json({ error: "gem not found" }); return; }
    if (!(await accountCanAccessGem(deps.db, key, version, accountId))) { res.status(404).json({ error: "gem not found" }); return; }
    const a = await getGemArchive(deps.db, key, version);
    if (!a) { res.status(404).json({ error: "gem not found" }); return; }
    const { gem } = importGem(Buffer.from(a.bytes));
    const game = gem.artifacts.find((x) => x.type === "game") as { html?: unknown } | undefined;
    if (!game || typeof game.html !== "string") { res.status(404).json({ error: "this gem has no game to play" }); return; }
    res.json({ html: game.html });
  };
}

// Access-gated archive download (the raw .gem bytes, base64-encoded for JSON transport). Same
// no-leak 404 rule as ownerGameMetaHandler/ownerGameHtmlHandler.
export function ownerGemArchiveHandler(deps: CatalogDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, DELETE, OPTIONS"); return; }
    const accountId = await sessionAccountId(deps, req);
    if (!accountId) { res.status(401).json({ error: "sign in required" }); return; }
    const key = String((req.query.key as string | undefined) ?? "");
    const version = String((req.query.version as string | undefined) ?? "");
    if (!key || !version) { res.status(404).json({ error: "gem not found" }); return; }
    if (!(await accountCanAccessGem(deps.db, key, version, accountId))) { res.status(404).json({ error: "gem not found" }); return; }
    const a = await getGemArchive(deps.db, key, version);
    if (!a) { res.status(404).json({ error: "gem not found" }); return; }
    res.json({ archiveBase64: Buffer.from(a.bytes).toString("base64") });
  };
}

// Access-gated gem detail (metadata for the owner/viewer's private detail page, across all
// visibilities). Same no-leak 404 rule as the other access-gated handlers.
export function ownerGemHandler(deps: CatalogDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "GET, DELETE, OPTIONS"); return; }
    const accountId = await sessionAccountId(deps, req);
    if (!accountId) { res.status(401).json({ error: "sign in required" }); return; }
    const key = String((req.query.key as string | undefined) ?? "");
    if (!key) { res.status(404).json({ error: "gem not found" }); return; }
    const g = await catalogGemForViewer(deps.db, key, accountId);
    if (!g) { res.status(404).json({ error: "gem not found" }); return; }
    res.json({
      key: g.gemKey, version: g.version, publishedBy: g.publishedBy, description: g.description ?? "",
      tags: g.tags ?? [], artifactKinds: g.artifactKinds ?? [], artifacts: g.artifacts ?? [],
      grade: g.grade ?? null, visibility: g.visibility ?? "public", installable: g.installable ?? false,
      createdAtMs: g.createdAtMs, updatedAtMs: g.updatedAtMs ?? g.createdAtMs,
    });
  };
}

export function installCatalog(expressApp: ExpressApp, deps: CatalogDeps): void {
  expressApp.delete("/api/catalog/gem", unpublishHandler(deps));
  expressApp.options("/api/catalog/gem", unpublishHandler(deps));
  for (const p of ["/api/catalog/my-gems"]) { expressApp.get(p, myGemsHandler(deps)); expressApp.options(p, myGemsHandler(deps)); }
  for (const p of ["/api/catalog/game-meta"]) { expressApp.get(p, ownerGameMetaHandler(deps)); expressApp.options(p, ownerGameMetaHandler(deps)); }
  for (const p of ["/api/catalog/game-html"]) { expressApp.get(p, ownerGameHtmlHandler(deps)); expressApp.options(p, ownerGameHtmlHandler(deps)); }
  for (const p of ["/api/catalog/gem-archive"]) { expressApp.get(p, ownerGemArchiveHandler(deps)); expressApp.options(p, ownerGemArchiveHandler(deps)); }
  for (const p of ["/api/catalog/gem-detail"]) { expressApp.get(p, ownerGemHandler(deps)); expressApp.options(p, ownerGemHandler(deps)); }
}
