// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { postCatalogShare } from "../catalogShareClient.js";
import type { Identity } from "@agentgem/model";

const identity: Identity = { publicKey: "ed25519:PUB", sign: (d) => "sig" + d.length };

describe("postCatalogShare", () => {
  it("signs the manifest and posts to the hosted catalog endpoint", async () => {
    const http = vi.fn(async (_url: string, _init: { method: string; headers: Record<string, string>; body: string }) => ({ status: 200, json: async () => ({ shared: true, publishedBy: "octocat" }) }));
    const res = await postCatalogShare({
      manifest: { gemKey: "@o/k", version: "1.0.0", description: "d" },
      identity, endpoint: "https://api.agentgem.ai", http, now: () => 1_000_000,
    });
    expect(res).toEqual({ shared: true, publishedBy: "octocat" });
    const [url, init] = http.mock.calls[0];
    expect(url).toBe("https://api.agentgem.ai/api/aggregator/catalog");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ pubkey: "ed25519:PUB", signedAt: 1_000_000, manifest: { gemKey: "@o/k" } });
    expect(typeof body.signature).toBe("string");
  });

  it("surfaces a rejected result", async () => {
    const http = vi.fn(async (_url: string, _init: { method: string; headers: Record<string, string>; body: string }) => ({ status: 200, json: async () => ({ shared: false, rejected: "not-connected" }) }));
    const res = await postCatalogShare({ manifest: { gemKey: "@o/k", version: "1.0.0" }, identity, endpoint: "https://api.agentgem.ai", http });
    expect(res).toEqual({ shared: false, rejected: "not-connected" });
  });
});
