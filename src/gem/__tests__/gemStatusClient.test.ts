// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import type { ShareHttp } from "@agentgem/app/gem/catalogShareClient";
import { postGemStatus } from "@agentgem/app/gem/gemStatusClient";

const fakeIdentity = { publicKey: "ed25519:AAAA", sign: (_d: string) => "sig" };

describe("postGemStatus", () => {
  it("signs the key and posts to /api/aggregator/gem-status, returning the status", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const http: ShareHttp = async (url, init) => {
      seen = { url, body: JSON.parse(String(init?.body ?? "{}")) };
      return { status: 200, json: async () => ({ exists: true, ownedByMe: true, latestVersion: "0.1.2" }) };
    };
    const res = await postGemStatus({ gemKey: "@me/game", identity: fakeIdentity, endpoint: "https://agg.test", http, now: () => 5 });
    expect(res).toEqual({ exists: true, ownedByMe: true, latestVersion: "0.1.2" });
    expect(seen!.url).toBe("https://agg.test/api/aggregator/gem-status");
    expect(seen!.body).toEqual({ key: "@me/game", pubkey: "ed25519:AAAA", signedAt: 5, signature: "sig" });
  });

  it("throws when the service returns a non-2xx", async () => {
    const http: ShareHttp = async () => ({ status: 503, json: async () => ({}) });
    await expect(postGemStatus({ gemKey: "@me/game", identity: fakeIdentity, endpoint: "https://agg.test", http })).rejects.toThrow();
  });
});
