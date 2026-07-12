// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { postReviewRequest, postReviewAction, fetchReviewArchive, type ReviewHttp } from "../reviewClient.js";
import type { Identity } from "@agentgem/model";

const identity: Identity = { publicKey: "ed25519:PUB", sign: (d) => "sig:" + d.length };
const manifest = { gemKey: "@team/bot", version: "1.0.0", gemDigest: "sha256:00" } as any;

type Init = Parameters<ReviewHttp>[1];

describe("reviewClient", () => {
  it("postReviewRequest signs reviewSubmitPayload (binds groupId) and POSTs /review/request", async () => {
    const http = vi.fn(async (_url: string, _init: Init) => ({ status: 200, json: async () => ({ ok: true, requestId: "req-1" }) }));
    const r = await postReviewRequest({ manifest, archiveBase64: "AAAA", groupId: "g-1", identity, endpoint: "https://agg.test", http, now: () => 1000 });
    expect(r).toEqual({ ok: true, requestId: "req-1" });
    const [url, init] = http.mock.calls[0];
    expect(url).toBe("https://agg.test/api/aggregator/review/request");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ manifest, archiveBase64: "AAAA", groupId: "g-1", pubkey: "ed25519:PUB", signedAt: 1000 });
    expect(typeof body.signature).toBe("string"); // signed reviewSubmitPayload, not catalogSigningPayload
  });

  it("postReviewAction binds action+requestId and returns the aggregator JSON", async () => {
    const http = vi.fn(async (_url: string, _init: Init) => ({ status: 200, json: async () => ({ requests: [] }) }));
    const r = await postReviewAction({ action: "inbox", requestId: "", path: "/review/inbox", identity, endpoint: "https://agg.test", http, now: () => 5 });
    expect(r).toEqual({ requests: [] });
    expect(http.mock.calls[0][0]).toBe("https://agg.test/api/aggregator/review/inbox");
  });

  it("fetchReviewArchive decodes archiveBase64 to bytes, or null", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const http = vi.fn(async (_url: string, _init: Init) => ({ status: 200, json: async () => ({ archiveBase64: bytes.toString("base64") }) }));
    const r = await fetchReviewArchive({ requestId: "req-1", identity, endpoint: "https://agg.test", http, now: () => 5 });
    expect(r && Array.from(r)).toEqual([1, 2, 3]);
    const http2 = vi.fn(async (_url: string, _init: Init) => ({ status: 200, json: async () => ({ archiveBase64: null }) }));
    expect(await fetchReviewArchive({ requestId: "x", identity, endpoint: "https://agg.test", http: http2 })).toBeNull();
  });

  it("throws InvalidInputError on a non-2xx forward", async () => {
    const http = vi.fn(async (_url: string, _init: Init) => ({ status: 500, json: async () => ({}) }));
    await expect(postReviewAction({ action: "approve", requestId: "r", path: "/review/approve", identity, endpoint: "https://agg.test", http })).rejects.toThrow();
  });
});
