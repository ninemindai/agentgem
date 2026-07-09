// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import type { makeAuth } from "@agentgem/aggregator";
import { BindingKey } from "@agentback/core";

// DI binding for the single app-wide better-auth instance (Plan 1b) — lets controllers that are
// resolved through the framework's context (e.g. GemController) inject it the same way they inject
// the drizzle client, instead of threading it through every constructor by hand.
export const AUTH_BINDING = BindingKey.create<ReturnType<typeof makeAuth> | undefined>("agentgem.auth");

type ExpressApp = { all(p: string, h: (req: any, res: any) => unknown): unknown };

// prefix is "/api/betterauth" in Plan 1a (coexists with the still-live old /api/auth/* handlers —
// Codex re-review #1: a single /api/auth/* catch-all would swallow the old routes), then flips to
// "/api/auth" in Plan 1b once the old OAuth is deleted. better-auth's baseURL must match the prefix.
// `auth` is typed off makeAuth's return (not a direct `better-auth` import) — this package doesn't
// depend on better-auth directly, only @agentgem/aggregator does.
export function mountAuth(expressApp: ExpressApp, auth: ReturnType<typeof makeAuth>, webOrigins: string[], prefix = "/api/auth"): void {
  // Express 5 (path-to-regexp v8) dropped the bare `*` wildcard — it now requires a named
  // splat segment (`/*splat`), unlike Express 4's `/*`.
  expressApp.all(`${prefix}/*splat`, async (req, res) => {
    const origin = req.headers["origin"];
    if (origin && webOrigins.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Credentials", "true");
      res.set("Vary", "Origin");
    }
    if (req.method === "OPTIONS") { res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS").set("Access-Control-Allow-Headers", "content-type, authorization").status(204).send(""); return; }
    const proto = req.headers["x-forwarded-proto"] ?? req.protocol ?? "https";
    const host = req.headers["host"];
    const url = new URL(req.originalUrl, `${proto}://${host}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const hasBody = !["GET", "HEAD"].includes(req.method) && req.body != null && Object.keys(req.body).length > 0;
    const request = new Request(url, { method: req.method, headers, body: hasBody ? JSON.stringify(req.body) : undefined });
    const resp = await auth.handler(request);
    res.status(resp.status);
    // Set-Cookie must be emitted individually — Fetch Headers COALESCES multiple Set-Cookie into one
    // comma-joined (invalid) string (Codex re-review #5). getSetCookie() returns them as an array.
    const cookies = resp.headers.getSetCookie?.() ?? [];
    for (const c of cookies) res.append("set-cookie", c);
    resp.headers.forEach((val: string, key: string) => { if (key.toLowerCase() !== "set-cookie") res.set(key, val); });
    res.send(Buffer.from(await resp.arrayBuffer()));
  });
}
