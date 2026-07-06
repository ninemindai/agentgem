// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { makeTestDb, listInstallations, upsertInstallation } from "@agentgem/aggregator";
import { verifyWebhookSignature, webhookHandler } from "../webhook.js";
import type { GithubAppDeps } from "../sync.js";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const secret = "hush";
const cfg = { appId: "1", privateKey: pem, webhookSecret: secret };
const sig = (raw: Buffer) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

function mockRes() {
  const r: any = { _status: 200, _body: undefined };
  r.status = (c: number) => { r._status = c; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  return r;
}
const mkReq = (raw: Buffer | undefined, headers: Record<string, string>) =>
  ({ rawBody: raw, body: raw ? JSON.parse(raw.toString()) : {}, headers }) as any;

async function makeDeps(): Promise<GithubAppDeps> {
  return { db: await makeTestDb(), cfg, tokens: null, http: async () => ({ status: 404, text: async () => "{}" }), fetchImpl: fetch };
}

describe("verifyWebhookSignature", () => {
  const raw = Buffer.from('{"a":1}');
  it("accepts the right sig, rejects wrong/missing/garbage", () => {
    expect(verifyWebhookSignature(raw, secret, sig(raw))).toBe(true);
    expect(verifyWebhookSignature(raw, secret, sig(Buffer.from("{}")))).toBe(false);
    expect(verifyWebhookSignature(raw, secret, undefined)).toBe(false);
    expect(verifyWebhookSignature(raw, secret, "sha256=nothex")).toBe(false);
    expect(verifyWebhookSignature(raw, secret, "sha1=abcd")).toBe(false);
  });
});

describe("webhookHandler", () => {
  it("503 when unconfigured", async () => {
    const deps = await makeDeps();
    const res = mockRes();
    webhookHandler({ ...deps, cfg: null })(mkReq(Buffer.from("{}"), {}), res);
    expect(res._status).toBe(503);
  });

  it("401 on bad signature or missing raw body; nothing processed", async () => {
    const deps = await makeDeps();
    const raw = Buffer.from(JSON.stringify({ action: "created", installation: { id: 7, account: { login: "acme", type: "Organization" }, repository_selection: "all" } }));
    let res = mockRes();
    webhookHandler(deps)(mkReq(raw, { "x-hub-signature-256": "sha256=deadbeef", "x-github-event": "installation" }), res);
    expect(res._status).toBe(401);
    res = mockRes();
    webhookHandler(deps)(mkReq(undefined, { "x-hub-signature-256": sig(raw), "x-github-event": "installation" }), res);
    expect(res._status).toBe(401);
    expect(await listInstallations(deps.db)).toEqual([]);
  });

  it("200 + async processing on a verified event", async () => {
    const deps = await makeDeps();
    await upsertInstallation(deps.db, { installationId: 7, orgScope: "acme", repoSelection: "all", suspended: false });
    const raw = Buffer.from(JSON.stringify({ action: "suspend", installation: { id: 7, account: { login: "acme", type: "Organization" }, repository_selection: "all" } }));
    const res = mockRes();
    webhookHandler(deps)(mkReq(raw, { "x-hub-signature-256": sig(raw), "x-github-event": "installation" }), res);
    expect(res._status).toBe(200); // acked BEFORE processing
    expect(res._body).toEqual({ ok: true });
    await vi.waitFor(async () => {
      expect((await listInstallations(deps.db))[0]?.suspended).toBe(true); // async handler landed
    });
  });
});
