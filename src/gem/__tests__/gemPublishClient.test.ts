// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { postGemPublish } from "@agentgem/app/gem/gemPublishClient";
import type { Identity } from "@agentgem/model";

const identity: Identity = { publicKey: "ed25519:PUB", sign: (d) => "sig" + d.length };

describe("postGemPublish", () => {
  it("signs the manifest and posts the archive to the installable-publish endpoint", async () => {
    const http = vi.fn(async (_url: string, _init: { method: string; headers: Record<string, string>; body: string }) => ({ status: 200, json: async () => ({ shared: true, publishedBy: "octocat" }) }));
    const res = await postGemPublish({
      manifest: { gemKey: "@o/setup", version: "1.0.0", artifacts: [{ name: "s", type: "skill" }], gemDigest: "sha256:x" },
      archiveBase64: "QUJD", identity, endpoint: "https://api.agentgem.ai", http, now: () => 1_000_000,
    });
    expect(res).toEqual({ shared: true, publishedBy: "octocat" });
    const [url, init] = http.mock.calls[0];
    expect(url).toBe("https://api.agentgem.ai/api/aggregator/publish-gem");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ pubkey: "ed25519:PUB", signedAt: 1_000_000, archiveBase64: "QUJD", manifest: { gemKey: "@o/setup", gemDigest: "sha256:x" } });
    expect(typeof body.signature).toBe("string");
  });

  it("surfaces a rejected result", async () => {
    const http = vi.fn(async () => ({ status: 200, json: async () => ({ shared: false, rejected: "not-connected" }) }));
    const res = await postGemPublish({ manifest: { gemKey: "@o/k", version: "1.0.0" }, archiveBase64: "QUJD", identity, endpoint: "https://api.agentgem.ai", http });
    expect(res).toEqual({ shared: false, rejected: "not-connected" });
  });

  it("throws a surfaceable 400 when the publish service is unreachable", async () => {
    const http = vi.fn(async () => ({ status: 502, json: async () => ({}) }));
    await expect(
      postGemPublish({ manifest: { gemKey: "@o/k", version: "1.0.0" }, archiveBase64: "QUJD", identity, endpoint: "https://api.agentgem.ai", http }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
