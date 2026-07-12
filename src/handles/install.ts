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
import { cors, preflight, type Req, type Res, type ExpressApp } from "../publicCors.js";

export interface HandleDeps { db: AppDb; auth: ReturnType<typeof makeAuth>; webOrigins: string[] }

export function claimHandler(deps: HandleDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res, "POST, OPTIONS"); return; }

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
