// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// POST /api/handle — claim or rename the caller's public handle (raw express, like catalog/stars/
// reviews install.ts): reachable cross-site, own credentialed CORS. The handle names; it never
// authorizes (ownership is the accounts.id uuid), so this route grants no access by itself.
//
// claimHandle (Task 5) owns every guard — charset, reserved-org-name, and the uniqueness race —
// this route is a thin adapter over it: it never re-validates and never writes "user".handle
// itself, and there is no second claim path.
//
// "taken" and "reserved" both collapse into claimHandle's single `reason: "unavailable"` and
// surface here as one 409 with one message, deliberately indistinguishable: separating them would
// let a prober enumerate which GitHub orgs the App has seen.
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { resolveSession, claimHandle } from "@agentgem/aggregator";

export interface HandleDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[] }

interface Req { method: string; path: string; query: Record<string, unknown>; body: Record<string, unknown>; headers: Record<string, string | undefined> }
interface Res { status(c: number): Res; set(k: string, v: string): Res; json(b: unknown): Res; send(b: unknown): Res }
type ExpressApp = { post(p: string, h: (req: Req, res: Res) => unknown): unknown; options(p: string, h: (req: Req, res: Res) => unknown): unknown };

function cors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}
function preflight(res: Res): void {
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS").set("Access-Control-Allow-Headers", "content-type").status(204).send("");
}

export function claimHandler(deps: HandleDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }

    const who = await resolveSession(deps.auth, req.headers);
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }

    const raw = req.body.handle;
    if (typeof raw !== "string") { res.status(400).json({ error: "handle is required" }); return; }

    const result = await claimHandle(deps.db, who.accountId, raw);
    if (result.ok) { res.json({ handle: result.handle }); return; }
    if (result.reason === "charset") { res.status(400).json({ error: "a handle is 1-39 characters of A-Z, a-z, 0-9 or -" }); return; }
    res.status(409).json({ error: "that handle is not available" });
  };
}

export function installHandles(expressApp: ExpressApp, deps: HandleDeps): void {
  expressApp.post("/api/handle", claimHandler(deps));
  expressApp.options("/api/handle", claimHandler(deps));
}
