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
const { createWorkspace } = vi.hoisted(() => ({ createWorkspace: vi.fn(() => ({ name: "review-req-1" })) }));
vi.mock("@agentgem/base", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentgem/base")>();
  return { ...actual, readWorkspace: () => ({ files: {} }), createWorkspace };
});
const { hasExecutableMock } = vi.hoisted(() => ({ hasExecutableMock: vi.fn(() => false) }));
vi.mock("../gem/hostedInstall.js", () => ({ executableArtifacts: () => ({ mcp: [], hooks: [] }), hasExecutable: hasExecutableMock }));
vi.mock("@agentgem/archive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentgem/archive")>();
  return { ...actual, readGemArchive: () => ({ name: "bot", artifacts: [{ name: "s", type: "skill" }], grade: 2, checks: [], requiredSecrets: [], createdFrom: "x" }) };
});
// importGem is a reconfigurable vi.fn() (default below) so the "play" describe can vary its return
// value per test (a game artifact / no game artifact) via mockReturnValueOnce without disturbing the
// fixed shape the other describes (request/resubmit/install) rely on.
const { importGemMock } = vi.hoisted(() => ({ importGemMock: vi.fn() }));
vi.mock("@agentgem/distribute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentgem/distribute")>();
  return {
    ...actual,
    exportGem: () => ({ bytes: Buffer.from([9]) }),
    importGem: importGemMock,
  };
});
importGemMock.mockReturnValue({ meta: { gemDigest: "sha256:zz", version: "2.3.0" }, gem: { artifacts: [], name: "bot", checks: [], requiredSecrets: [], createdFrom: "x" } });

const { readSession } = vi.hoisted(() => ({ readSession: vi.fn() }));
vi.mock("../bind/bindCore.js", () => ({ readSession, clearSession: vi.fn(), bindConfig: () => ({ base: "https://agg.test" }) }));

import { ReviewController } from "../review.controller.js";
import { postReviewAction, fetchReviewArchive } from "../gem/reviewClient.js";
import { clearSession } from "../bind/bindCore.js";
const action = postReviewAction as unknown as ReturnType<typeof vi.fn>;
const fetchArch = fetchReviewArchive as unknown as ReturnType<typeof vi.fn>;
const clearSess = clearSession as unknown as ReturnType<typeof vi.fn>;

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
  // Pin the exact signed verb + path for the remaining action routes (a verb typo fails aggregator
  // signature verification with a 401 — loud, but cheap to guard against a future refactor).
  it("getOne signs the 'get' action with the query requestId", async () => {
    action.mockResolvedValue({ request: null });
    await new ReviewController().getOne({ query: { requestId: "r7" } });
    expect(action.mock.calls[0][0]).toMatchObject({ action: "get", requestId: "r7", path: "/review/get" });
  });
  it("changes signs the 'changes' action", async () => {
    action.mockResolvedValue({ ok: true });
    await new ReviewController().changes({ body: { requestId: "r7" } });
    expect(action.mock.calls[0][0]).toMatchObject({ action: "changes", requestId: "r7", path: "/review/changes" });
  });
  it("withdraw signs the 'withdraw' action", async () => {
    action.mockResolvedValue({ ok: true });
    await new ReviewController().withdraw({ body: { requestId: "r7" } });
    expect(action.mock.calls[0][0]).toMatchObject({ action: "withdraw", requestId: "r7", path: "/review/withdraw" });
  });
  it("seen signs the 'seen' action", async () => {
    action.mockResolvedValue({ ok: true });
    await new ReviewController().seen({ body: { requestId: "r7" } });
    expect(action.mock.calls[0][0]).toMatchObject({ action: "seen", requestId: "r7", path: "/review/seen" });
  });
});

describe("ReviewController install-to-test", () => {
  beforeEach(() => {
    fetchArch.mockReset();
    createWorkspace.mockReset();
    createWorkspace.mockReturnValue({ name: "review-req-1" });
    hasExecutableMock.mockReset();
    hasExecutableMock.mockReturnValue(false);
  });
  it("fetches the signed archive, verifies, and creates a workspace when no executables", async () => {
    fetchArch.mockResolvedValue(Buffer.from([9]));
    const res = await new ReviewController().install({ body: { requestId: "req-1" } });
    expect(res).toMatchObject({ workspace: "review-req-1", executables: { mcp: [], hooks: [] } });
    expect(fetchArch.mock.calls[0][0].requestId).toBe("req-1");
    // The STAGED version (importGem meta.version) is threaded to createWorkspace, not defaulted to 0.1.0.
    expect((createWorkspace.mock.calls[0] as unknown[])[2]).toEqual({ version: "2.3.0" });
  });
  it("returns 404-ish when the archive is gone (null)", async () => {
    fetchArch.mockResolvedValue(null);
    await expect(new ReviewController().install({ body: { requestId: "gone" } })).rejects.toThrow();
  });
  it("requires consent (409) when the staged gem has executable artifacts", async () => {
    fetchArch.mockResolvedValue(Buffer.from([9]));
    hasExecutableMock.mockReturnValue(true);
    await expect(new ReviewController().install({ body: { requestId: "req-1" } })).rejects.toThrow();
  });
});

describe("ReviewController play", () => {
  beforeEach(() => { fetchArch.mockReset(); });

  it("returns the game html for a staged game gem", async () => {
    fetchArch.mockResolvedValue(Buffer.from([9]));
    importGemMock.mockReturnValueOnce({
      meta: { gemDigest: "sha256:zz", version: "1.0.0" },
      gem: { artifacts: [{ type: "game", html: "<h1>hi</h1>" }], name: "bot", checks: [], requiredSecrets: [], createdFrom: "x" },
    });
    const res = await new ReviewController().play({ body: { requestId: "r1" } });
    expect(res).toEqual({ html: "<h1>hi</h1>" });
    expect(fetchArch.mock.calls[0][0].requestId).toBe("r1");
  });

  it("surfaces the game's declared needs (informational; play stays broker-less)", async () => {
    fetchArch.mockResolvedValue(Buffer.from([9]));
    importGemMock.mockReturnValueOnce({
      meta: { gemDigest: "sha256:zz", version: "1.0.0" },
      gem: { artifacts: [{ type: "game", html: "<h1>hi</h1>", needs: ["session-data", "open-link"] }], name: "bot", checks: [], requiredSecrets: [], createdFrom: "x" },
    });
    const res = await new ReviewController().play({ body: { requestId: "r1" } });
    expect(res).toEqual({ html: "<h1>hi</h1>", needs: ["session-data", "open-link"] });
  });

  it("rejects (not_a_game) when the staged gem has no game artifact", async () => {
    fetchArch.mockResolvedValue(Buffer.from([9]));
    importGemMock.mockReturnValueOnce({
      meta: { gemDigest: "sha256:zz", version: "1.0.0" },
      gem: { artifacts: [{ type: "skill", name: "s" }], name: "bot", checks: [], requiredSecrets: [], createdFrom: "x" },
    });
    await expect(new ReviewController().play({ body: { requestId: "r1" } })).rejects.toThrow();
  });

  it("rejects (review_archive_gone) when the archive is gone", async () => {
    fetchArch.mockResolvedValue(null);
    await expect(new ReviewController().play({ body: { requestId: "gone" } })).rejects.toThrow();
  });
});

describe("ReviewController groups", () => {
  beforeEach(() => { readSession.mockReset(); clearSess.mockReset(); vi.unstubAllGlobals(); });

  it("returns authenticated:false with no session (and does not fetch)", async () => {
    readSession.mockReturnValue(null);
    const fetchSpy = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({ status: 200, json: async () => ({ groups: [] }) }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await new ReviewController().groups()).toEqual({ authenticated: false, groups: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bearer-fetches the aggregator groups list and maps the real /api/catalog/groups shape", async () => {
    readSession.mockReturnValue({ sessionToken: "tok" });
    // Real shape (packages/aggregator/src/groups.ts listGroupsForAccount): { groups: (Group & { role })[] }
    // where Group = { id, kind, installationId, scope, name } — extra fields beyond {id,name,role}.
    const fetchSpy = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({
      status: 200,
      json: async () => ({ groups: [{ id: "g1", kind: "native", installationId: null, scope: null, name: "Team", role: "admin" }] }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await new ReviewController().groups();
    expect(res).toEqual({ authenticated: true, groups: [{ id: "g1", name: "Team", role: "admin" }] });
    expect(fetchSpy.mock.calls[0][0].toString()).toBe("https://agg.test/api/catalog/groups");
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Bearer tok" } });
  });

  it("clears the session and returns authenticated:false on 401", async () => {
    readSession.mockReturnValue({ sessionToken: "stale" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 401, json: async () => ({}) })));
    expect(await new ReviewController().groups()).toEqual({ authenticated: false, groups: [] });
    expect(clearSess).toHaveBeenCalled();
  });

  it("returns authenticated:true with empty groups on other non-2xx", async () => {
    readSession.mockReturnValue({ sessionToken: "tok" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 500, json: async () => ({}) })));
    expect(await new ReviewController().groups()).toEqual({ authenticated: true, groups: [] });
  });

  it("degrades to an empty picker (no throw) when the aggregator fetch rejects", async () => {
    readSession.mockReturnValue({ sessionToken: "tok" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await new ReviewController().groups()).toEqual({ authenticated: true, groups: [] });
  });
});
