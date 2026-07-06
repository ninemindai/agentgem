// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/githubApp/webhook.ts
// POST /api/github/webhook. HMAC-SHA256 over the RAW body (captured by the bodyParser `verify`
// hook in src/index.ts — re-serializing req.body is NOT byte-faithful) compared with
// timingSafeEqual. Verified events ack 200 immediately and process async: GitHub times out at
// 10s and does not auto-retry, so indexing must never block the ack. Handlers are idempotent;
// a processing failure logs and waits for the daily reconcile.
import { createHmac, timingSafeEqual } from "node:crypto";
import { handleWebhookEvent, type GithubAppDeps } from "./sync.js";

export function verifyWebhookSignature(raw: Buffer, secret: string, sigHeader: string | undefined): boolean {
  if (!sigHeader || !sigHeader.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const got = Buffer.from(sigHeader.slice("sha256=".length), "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

interface WebhookReq { rawBody?: Buffer; body: unknown; headers: Record<string, string | string[] | undefined> }
interface WebhookRes { status(c: number): WebhookRes; json(b: unknown): WebhookRes }

export function webhookHandler(deps: GithubAppDeps) {
  return (req: WebhookReq, res: WebhookRes): void => {
    if (!deps.cfg) { res.status(503).json({ error: "github app not configured" }); return; }
    const raw = req.rawBody;
    const sig = req.headers["x-hub-signature-256"];
    if (!raw || !verifyWebhookSignature(raw, deps.cfg.webhookSecret, typeof sig === "string" ? sig : undefined)) {
      res.status(401).json({ error: "bad signature" });
      return;
    }
    const event = String(req.headers["x-github-event"] ?? "");
    res.status(200).json({ ok: true }); // ack before processing — see file comment
    void handleWebhookEvent(deps, event, req.body).catch((e) => {
      console.error(`githubApp: ${event} handler failed: ${(e as Error).message}`);
    });
  };
}

export function installGithubWebhook(expressApp: { post(p: string, h: unknown): unknown }, deps: GithubAppDeps): void {
  expressApp.post("/api/github/webhook", webhookHandler(deps));
}
