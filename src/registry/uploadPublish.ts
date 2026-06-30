// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/registry/uploadPublish.ts
//
// Signed-in .gem upload → publish, with #4a attribution (publishedBy = the verified
// session login) and a scope===login safety rail (you may only publish under your own
// handle). Raw-express + credentialed CORS + originGuard-exempt, mirroring auth/stars.
// The richer scope-ownership model (org/claimed) is #4b. importGem rejects tampering.
import type { AppDb } from "@agentgem/aggregator";
import { resolveSession } from "@agentgem/aggregator";
import { importGem, publishGem, type RegistrySource, type RegistryPublisher } from "@agentgem/distribute";
import { parseCookies, SESSION_COOKIE } from "../auth/cookie.js";
import { resolvePublishType, type GemTypeRegistry } from "../gem/gemTypeRegistry.js";
import { InvalidInputError } from "@agentgem/model";

export interface UploadPublishDeps { db: AppDb; webOrigins: string[]; source: RegistrySource; publisher: RegistryPublisher; gemTypes: GemTypeRegistry }
type Req = { method?: string; headers: Record<string, string | undefined>; body?: Record<string, unknown> };
type Res = { status(c: number): Res; set(k: string, v: string): Res; json(b: unknown): Res; send(b: unknown): Res };

function cors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}

export function uploadPublishHandler(deps: UploadPublishDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS").set("Access-Control-Allow-Headers", "content-type").status(204).send("");
      return;
    }
    const token = parseCookies(req.headers["cookie"])[SESSION_COOKIE];
    const who = token ? await resolveSession(deps.db, token) : null;
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }

    const body = (req.body ?? {}) as { scope?: unknown; version?: unknown; name?: unknown; tags?: unknown; description?: unknown; type?: unknown; bytesBase64?: unknown };
    const scope = typeof body.scope === "string" ? body.scope.trim() : "";
    const version = typeof body.version === "string" ? body.version.trim() : "";
    if (!scope || !version) { res.status(400).json({ error: "scope and version are required" }); return; }
    // SAFETY RAIL: you may only publish under your own login (the #4b model is deferred).
    if (scope !== who.login) { res.status(403).json({ error: `you can only publish under your own login (@${who.login})` }); return; }
    if (typeof body.bytesBase64 !== "string") { res.status(400).json({ error: "bytesBase64 is required" }); return; }

    let gem;
    try {
      gem = importGem(Buffer.from(body.bytesBase64, "base64")).gem;        // verifies gem.lock; throws on tamper/parse
    } catch {
      res.status(400).json({ error: "invalid or tampered .gem archive" }); return;
    }
    try {
      const type = resolvePublishType(deps.gemTypes, typeof body.type === "string" ? body.type : undefined, gem);
      const index = await deps.source.getIndex();                         // fresh per request
      const result = await publishGem({
        gem, scope, version,
        name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined,
        tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        index, publisher: deps.publisher, type,
        publishedBy: who.login,                                            // VERIFIED attribution (#4a)
      });
      res.json(result);
    } catch (err) {
      const msg = (err as Error).message;
      // User-actionable input errors (unknown type, bad scope/name, version immutability) → 400.
      // Unexpected infra failures (registry network / GitHub) → 500 generic, no internal leak.
      if (err instanceof InvalidInputError || /immutable|already published|invalid (scope|version|semver|ref)/i.test(msg)) {
        res.status(400).json({ error: msg }); return;
      }
      console.error("upload-publish: publish failed:", msg);
      res.status(500).json({ error: "publish failed" });
    }
  };
}

export function installRegistryUploadPublish(expressApp: { post(p: string, h: unknown): void; options(p: string, h: unknown): void }, deps: UploadPublishDeps): void {
  const h = uploadPublishHandler(deps);
  expressApp.post("/api/registry/upload-publish", h as never);
  expressApp.options("/api/registry/upload-publish", h as never);
}
