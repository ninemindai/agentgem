// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { postShareArchive, postShareArchiveRevoke } from "../gem/shareArchiveClient.js";

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { publicKey: pub, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}

describe("shareArchiveClient", () => {
  it("mint: POSTs a signed body to /share-archive and returns key+url", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const http = async (url: string, init: { body: string }) => { calls.push({ url, body: JSON.parse(init.body) }); return { status: 200, json: async () => ({ key: "xK3f9a2Bq1", url: "https://app.agentgem.ai/games/xK3f9a2Bq1" }) }; };
    const res = await postShareArchive({ manifest: { gemKey: "_", version: "1", gemDigest: "sha256:abc" }, archiveBase64: "AA==", identity: identity(), endpoint: "https://api.test", http, now: () => 1000 });
    expect(res).toEqual({ ok: true, key: "xK3f9a2Bq1", url: "https://app.agentgem.ai/games/xK3f9a2Bq1" });
    expect(calls[0].url).toBe("https://api.test/api/aggregator/share-archive");
    expect(calls[0].body).toMatchObject({ pubkey: expect.stringMatching(/^ed25519:/), signedAt: 1000 });
  });

  it("revoke: signs revoke:<key>:<signedAt> and POSTs to /share-archive/revoke", async () => {
    const id = identity();
    let sent: { key: string; pubkey: string; signedAt: number; signature: string } | null = null;
    const http = async (_url: string, init: { body: string }) => { sent = JSON.parse(init.body); return { status: 200, json: async () => ({ revoked: true }) }; };
    const res = await postShareArchiveRevoke({ key: "xK3f9a2Bq1", identity: id, endpoint: "https://api.test", http, now: () => 2000 });
    expect(res).toEqual({ ok: true });
    // the signature must verify over exactly revoke:<key>:<signedAt>
    const spki = Buffer.from(id.publicKey.slice("ed25519:".length), "base64");
    const key = { key: spki, format: "der" as const, type: "spki" as const };
    expect(edVerify(null, Buffer.from(`revoke:xK3f9a2Bq1:2000`), { key: spki, format: "der", type: "spki" } as never, Buffer.from(sent!.signature, "base64"))).toBe(true);
  });

  it("surfaces a non-2xx as { ok: false }", async () => {
    const http = async () => ({ status: 401, json: async () => ({ code: "not-connected" }) });
    const res = await postShareArchive({ manifest: { gemKey: "_", version: "1", gemDigest: "x" }, archiveBase64: "AA==", identity: identity(), endpoint: "https://api.test", http, now: () => 1 });
    expect(res.ok).toBe(false);
  });
});
