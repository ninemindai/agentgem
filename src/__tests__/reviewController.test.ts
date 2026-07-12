// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentgem/model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentgem/model")>();
  return { ...actual, loadOrCreateIdentity: () => ({ publicKey: "ed25519:PUB", sign: (_d: string) => "sig" }) };
});
// vi.mock factories are hoisted above the rest of the module, so the spies they reference must be
// created via vi.hoisted (a bare top-level `const x = vi.fn()` referenced below throws a
// "Cannot access before initialization" TDZ error at import time).
const { postReviewRequest, postReviewResubmit } = vi.hoisted(() => ({ postReviewRequest: vi.fn(), postReviewResubmit: vi.fn() }));
vi.mock("../gem/reviewClient.js", () => ({ postReviewRequest, postReviewResubmit, postReviewAction: vi.fn(), fetchReviewArchive: vi.fn() }));
// Mock the workspace→gem build so no FS is touched; return a minimal gem + bytes.
vi.mock("@agentgem/base", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentgem/base")>();
  return { ...actual, readWorkspace: () => ({ files: {} }) };
});
vi.mock("@agentgem/archive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentgem/archive")>();
  return { ...actual, readGemArchive: () => ({ name: "bot", artifacts: [{ name: "s", type: "skill" }], grade: 2, checks: [], requiredSecrets: [], createdFrom: "x" }) };
});
vi.mock("@agentgem/distribute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentgem/distribute")>();
  return {
    ...actual,
    exportGem: () => ({ bytes: Buffer.from([9]) }),
    importGem: () => ({ meta: { gemDigest: "sha256:zz" }, gem: { artifacts: [], name: "bot", checks: [], requiredSecrets: [], createdFrom: "x" } }),
  };
});

import { ReviewController } from "../review.controller.js";
import { postReviewAction } from "../gem/reviewClient.js";
const action = postReviewAction as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => { postReviewRequest.mockReset(); postReviewResubmit.mockReset(); });

describe("ReviewController submit/resubmit", () => {
  it("request builds a manifest (no visibility) and forwards via postReviewRequest, returning requestId", async () => {
    postReviewRequest.mockResolvedValue({ ok: true, requestId: "req-1" });
    const c = new ReviewController();
    const res = await c.request({ body: { workspace: "bot", scope: "team", version: "1.0.0", groupId: "g-1", description: "please" } });
    expect(res).toEqual({ ok: true, requestId: "req-1" });
    const arg = postReviewRequest.mock.calls[0][0];
    expect(arg.groupId).toBe("g-1");
    expect(arg.manifest).toMatchObject({ gemKey: "team/bot", version: "1.0.0", gemDigest: "sha256:zz" });
    expect(arg.manifest.visibility).toBeUndefined(); // staged gems don't carry visibility
    expect(arg.archiveBase64).toBe(Buffer.from([9]).toString("base64"));
  });

  it("request maps a rejection through", async () => {
    postReviewRequest.mockResolvedValue({ ok: false, rejected: "not-scope-owner" });
    const c = new ReviewController();
    expect(await c.request({ body: { workspace: "bot", scope: "team", version: "1.0.0", groupId: "g-1" } })).toEqual({ ok: false, rejected: "not-scope-owner" });
  });

  it("resubmit forwards via postReviewResubmit with the requestId", async () => {
    postReviewResubmit.mockResolvedValue({ ok: true });
    const c = new ReviewController();
    const res = await c.resubmit({ body: { workspace: "bot", scope: "team", version: "1.0.0", requestId: "req-1" } });
    expect(res).toEqual({ ok: true });
    expect(postReviewResubmit.mock.calls[0][0].requestId).toBe("req-1");
  });
});

describe("ReviewController action routes", () => {
  beforeEach(() => action.mockReset());
  it("inbox signs the inbox action and returns requests", async () => {
    action.mockResolvedValue({ requests: [{ id: "r1" }] });
    const res = await new ReviewController().inbox();
    expect(res).toEqual({ requests: [{ id: "r1" }] });
    expect(action.mock.calls[0][0]).toMatchObject({ action: "inbox", requestId: "", path: "/review/inbox" });
  });
  it("message binds the body into the signed action", async () => {
    action.mockResolvedValue({ ok: true });
    await new ReviewController().message({ body: { requestId: "r1", body: "looks good" } });
    expect(action.mock.calls[0][0]).toMatchObject({ action: "message:looks good", requestId: "r1", path: "/review/message", extra: { body: "looks good" } });
  });
  it("approve returns the aggregator result verbatim", async () => {
    action.mockResolvedValue({ ok: true, gemKey: "@team/bot", version: "1.0.0" });
    expect(await new ReviewController().approve({ body: { requestId: "r1" } })).toMatchObject({ ok: true, gemKey: "@team/bot" });
  });
});
