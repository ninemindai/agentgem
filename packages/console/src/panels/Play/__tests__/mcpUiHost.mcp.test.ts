// packages/console/src/panels/Play/__tests__/mcpUiHost.mcp.test.ts
// The router's mcp/call + mcp/list branches (PR-3a Task 5). Mirrors mcpUiHost.test.ts's harness
// (a `target={postMessage:vi.fn()}` fake, `msg(source, data)`, `requestConsent=vi.fn(async()=>true)`)
// but spies on playMcpCallRoute/playMcpServersRoute directly, same as the existing suite spies on
// playSessionDataRoute/inventoryRoute — no vi.mock needed.
//
// THE SECURITY INVARIANT this file exists to pin: every mcp/call path (grant, denial, cache-hit,
// digest-changed, out-of-manifest) routes through getMcpConsent/requestConsent — there is no fast path
// that reaches playMcpCallRoute without a consent decision behind it — and the connector config digest,
// which the consent record is pinned to, never leaks into a frame-bound reply.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { playMcpCallRoute, playMcpServersRoute } from "../../../api/routes.js";
import { AUTO_CAPS, getMcpConsent, setMcpConsent } from "../consent.js";
import { createUiHost, type UiHostDeps } from "../mcpUiHost.js";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const tick = () => new Promise((r) => setTimeout(r, 0));

function mkHost(over: Partial<UiHostDeps> = {}) {
  const target = { postMessage: vi.fn() } as unknown as Window;
  const requestConsent = vi.fn(async () => true);
  const deps: UiHostDeps = {
    apiBase: "", name: "g1", needs: [], interactive: true, target, requestConsent,
    mcpNeeds: [{ server: "github", tools: ["list_pull_requests", "list_commits"] }],
    ...over,
  };
  const host = createUiHost(deps);
  return { host, target, requestConsent, deps };
}
const posted = (target: Window) => (target.postMessage as unknown as ReturnType<typeof vi.fn>);
const msg = (source: unknown, data: Record<string, unknown>): MessageEvent =>
  ({ data: { jsonrpc: "2.0", ...data }, source }) as unknown as MessageEvent;

// A servers-route stub: one entry per declared server. Omit `configDigest` for "not installed".
const serversEnvelope = (...servers: { server: string; tools?: string[]; configDigest?: string }[]) => ({
  servers: servers.map((s) => ({
    server: s.server,
    tools: (s.tools ?? []).map((name) => ({ name })),
    ...(s.configDigest !== undefined ? { configDigest: s.configDigest } : {}),
  })),
});

describe("mcpUiHost — mcp/list", () => {
  it("before any consent, an installed-but-ungranted server reports needsConsent with empty tools", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "github", tools: ["list_pull_requests", "list_commits"], configDigest: "d1" }));
    const { host, target } = mkHost();
    host.handleMessage(msg(target, { method: "mcp/list", id: 1 }));
    await tick();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({
      id: 1, result: { servers: [{ server: "github", tools: [], status: "needsConsent" }] },
    }), "*");
  });

  it("after a granted + matching-digest consent, reports the declared∩connector tools with status granted", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "github", tools: ["list_pull_requests", "list_commits", "delete_repo"], configDigest: "d1" }));
    setMcpConsent("g1", "github", "granted", "d1");
    const { host, target } = mkHost();
    host.handleMessage(msg(target, { method: "mcp/list", id: 2 }));
    await tick();
    // delete_repo is a connector tool but NOT declared by the miniapp — excluded from the intersection.
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({
      id: 2, result: { servers: [{ server: "github", tools: ["list_pull_requests", "list_commits"], status: "granted" }] },
    }), "*");
  });

  it("a declared server with no installed gem reports unavailable with empty tools", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "github" })); // no configDigest = not installed
    const { host, target } = mkHost();
    host.handleMessage(msg(target, { method: "mcp/list", id: 3 }));
    await tick();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({
      id: 3, result: { servers: [{ server: "github", tools: [], status: "unavailable" }] },
    }), "*");
  });

  it("a prior denial pinned to the current digest reports denied WITHOUT prompting", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "github", tools: ["list_pull_requests"], configDigest: "d1" }));
    setMcpConsent("g1", "github", "denied", "d1");
    const { host, target, requestConsent } = mkHost();
    host.handleMessage(msg(target, { method: "mcp/list", id: 4 }));
    await tick();
    expect(requestConsent).not.toHaveBeenCalled(); // mcp/list NEVER prompts
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({
      id: 4, result: { servers: [{ server: "github", tools: [], status: "denied" }] },
    }), "*");
  });

  it("the connector's configDigest is NEVER present anywhere in the mcp/list reply", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "github", tools: ["list_pull_requests"], configDigest: "sekret-digest" }));
    setMcpConsent("g1", "github", "granted", "sekret-digest");
    const { host, target } = mkHost();
    host.handleMessage(msg(target, { method: "mcp/list", id: 5 }));
    await tick();
    const call = posted(target).mock.calls.find((c) => (c[0] as { id?: number }).id === 5)!;
    expect(JSON.stringify(call[0])).not.toContain("sekret-digest");
  });
});

describe("mcpUiHost — mcp/call consent gate", () => {
  it("no prior consent + requestConsent→true: grants+pins the digest, calls the route, replies the ok envelope", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "github", tools: ["list_pull_requests"], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: { items: [] } });
    const { host, target, requestConsent } = mkHost();
    host.handleMessage(msg(target, { method: "mcp/call", id: 10, params: { server: "github", tool: "list_pull_requests", input: {} } }));
    await tick();
    expect(requestConsent).toHaveBeenCalledWith("mcp:github", expect.stringContaining("github"));
    expect(getMcpConsent("g1", "github")).toEqual({ decision: "granted", digest: "d1" });
    expect(callSpy).toHaveBeenCalledWith(expect.anything(), { body: { name: "g1", server: "github", tool: "list_pull_requests", input: {}, expectedConfigDigest: "d1" } });
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 10, result: { ok: true, payload: { items: [] } } }), "*");
  });

  it("requestConsent→false: pins a denial, replies not_granted, and NEVER calls the route", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "github", tools: ["list_pull_requests"], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true });
    const { host, target } = mkHost({ requestConsent: vi.fn(async () => false) });
    host.handleMessage(msg(target, { method: "mcp/call", id: 11, params: { server: "github", tool: "list_pull_requests", input: {} } }));
    await tick();
    expect(getMcpConsent("g1", "github")).toEqual({ decision: "denied", digest: "d1" });
    expect(callSpy).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 11, result: { ok: false, error: { code: "not_granted", message: expect.any(String) } } }), "*");
  });

  it("prior granted + SAME digest: no re-prompt, calls the route straight through", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "github", tools: ["list_pull_requests"], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: {} });
    setMcpConsent("g1", "github", "granted", "d1");
    const { host, target, requestConsent } = mkHost();
    host.handleMessage(msg(target, { method: "mcp/call", id: 12, params: { server: "github", tool: "list_pull_requests", input: {} } }));
    await tick();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(callSpy).toHaveBeenCalled();
  });

  it("prior granted but digest CHANGED: re-prompts (consent does not survive a connector reconfig)", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "github", tools: ["list_pull_requests"], configDigest: "d2" }));
    vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: {} });
    setMcpConsent("g1", "github", "granted", "d1"); // stale digest
    const { host, target, requestConsent } = mkHost();
    host.handleMessage(msg(target, { method: "mcp/call", id: 13, params: { server: "github", tool: "list_pull_requests", input: {} } }));
    await tick();
    expect(requestConsent).toHaveBeenCalled();
    expect(getMcpConsent("g1", "github")).toEqual({ decision: "granted", digest: "d2" });
  });

  it("prior denied + same digest: replies not_granted WITHOUT re-prompting", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "github", tools: ["list_pull_requests"], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true });
    setMcpConsent("g1", "github", "denied", "d1");
    const { host, target, requestConsent } = mkHost();
    host.handleMessage(msg(target, { method: "mcp/call", id: 14, params: { server: "github", tool: "list_pull_requests", input: {} } }));
    await tick();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 14, result: { ok: false, error: { code: "not_granted", message: expect.any(String) } } }), "*");
  });

  it("a (server, tool) pair NOT in mcpNeeds is fast-rejected: no route call, no prompt, no /servers fetch", async () => {
    const serversSpy = vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "github", tools: ["list_pull_requests"], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true });
    const { host, target, requestConsent } = mkHost();
    host.handleMessage(msg(target, { method: "mcp/call", id: 15, params: { server: "github", tool: "delete_repo", input: {} } }));
    await tick();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(serversSpy).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 15, result: { ok: false, error: { code: "not_in_manifest", message: expect.any(String) } } }), "*");
  });

  it("an undeclared server is fast-rejected the same way", async () => {
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true });
    const { host, target } = mkHost();
    host.handleMessage(msg(target, { method: "mcp/call", id: 16, params: { server: "slack", tool: "post_message", input: {} } }));
    await tick();
    expect(callSpy).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 16, result: { ok: false, error: { code: "not_in_manifest", message: expect.any(String) } } }), "*");
  });

  it("an uninstalled connector (digest undefined) replies server_not_connected without prompting", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "github" })); // no configDigest
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true });
    const { host, target, requestConsent } = mkHost();
    host.handleMessage(msg(target, { method: "mcp/call", id: 17, params: { server: "github", tool: "list_pull_requests", input: {} } }));
    await tick();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 17, result: { ok: false, error: { code: "server_not_connected", message: expect.any(String) } } }), "*");
  });

  it("route returns server_config_changed: clears the cached digest + consent, replies the error, does not auto-retry", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "github", tools: ["list_pull_requests"], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: false, error: { code: "server_config_changed", message: "connector config changed" } });
    setMcpConsent("g1", "github", "granted", "d1");
    const { host, target } = mkHost();
    host.handleMessage(msg(target, { method: "mcp/call", id: 18, params: { server: "github", tool: "list_pull_requests", input: {} } }));
    await tick();
    expect(callSpy).toHaveBeenCalledTimes(1); // no auto-loop
    expect(getMcpConsent("g1", "github")).toBeNull(); // consent cleared — next call re-prompts
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 18, result: { ok: false, error: { code: "server_config_changed", message: expect.any(String) } } }), "*");
  });
});

describe("mcpUiHost — mcp security invariants", () => {
  it("AUTO_CAPS never holds an mcp: key — every connector call must be consent-gated", () => {
    for (const cap of AUTO_CAPS) expect(cap.startsWith("mcp:")).toBe(false);
  });

  it("a foreign-source message (e.source !== target) with method mcp/call is ignored", async () => {
    const serversSpy = vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "github", tools: ["list_pull_requests"], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true });
    const { host, requestConsent } = mkHost();
    host.handleMessage({ data: { jsonrpc: "2.0", method: "mcp/call", id: 19, params: { server: "github", tool: "list_pull_requests", input: {} } }, source: { other: true } } as unknown as MessageEvent);
    await tick();
    expect(serversSpy).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
    expect(requestConsent).not.toHaveBeenCalled();
  });

  it("a foreign-source message with method mcp/list is ignored", async () => {
    const serversSpy = vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "github", tools: [], configDigest: "d1" }));
    const { host } = mkHost();
    host.handleMessage({ data: { jsonrpc: "2.0", method: "mcp/list", id: 20 }, source: { other: true } } as unknown as MessageEvent);
    await tick();
    expect(serversSpy).not.toHaveBeenCalled();
  });

  it("bumpGeneration clears the cached digests, so a stale in-flight mcp/call reply is dropped", async () => {
    let resolveServers!: (v: unknown) => void;
    vi.spyOn(playMcpServersRoute, "call").mockReturnValue(new Promise((r) => { resolveServers = r; }) as never);
    const { host, target } = mkHost();
    host.handleMessage(msg(target, { method: "mcp/call", id: 21, params: { server: "github", tool: "list_pull_requests", input: {} } }));
    await tick();
    host.bumpGeneration(); // game changed while /servers was in flight
    resolveServers(serversEnvelope({ server: "github", tools: ["list_pull_requests"], configDigest: "d1" }));
    await tick();
    expect(posted(target)).not.toHaveBeenCalledWith(expect.objectContaining({ id: 21 }), "*");
  });
});
