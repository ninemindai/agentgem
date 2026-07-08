// packages/console/src/panels/Play/__tests__/mcpUiHost.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { playSessionDataRoute, inventoryRoute } from "../../../api/routes.js";
import * as watchStream from "../../Watch/watchStream.js";
import * as studioStream from "../studioStream.js";
import { createUiHost, type UiHostDeps } from "../mcpUiHost.js";

afterEach(() => { vi.restoreAllMocks(); });

const tick = () => new Promise((r) => setTimeout(r, 0));

// A fake host target (the iframe.contentWindow). Every inbound message's `source` must === this target.
function mkHost(over: Partial<UiHostDeps> = {}) {
  const target = { postMessage: vi.fn() } as unknown as Window;
  const requestConsent = vi.fn(async () => true);
  const deps: UiHostDeps = { apiBase: "", name: "g1", needs: ["session-data"], interactive: true, target, requestConsent, ...over };
  const host = createUiHost(deps);
  return { host, target, requestConsent, deps };
}
const posted = (target: Window) => (target.postMessage as unknown as ReturnType<typeof vi.fn>);
// Inbound message from the trusted target (jsonrpc filled in for you).
const msg = (source: unknown, data: Record<string, unknown>): MessageEvent =>
  ({ data: { jsonrpc: "2.0", ...data }, source }) as unknown as MessageEvent;
const sess = (file: string) => ({ id: "s", file, agent: "claude" as const, project: null, model: null, msgs: 1, startMs: 0, endMs: 0, ageMs: 0 });

describe("mcpUiHost — handshake + advertisement", () => {
  it("ui/initialize advertises ONLY the tools whose capability ∈ needs", () => {
    const { host, target } = mkHost({ needs: ["session-data", "invoke-agent"] });
    host.handleMessage(msg(target, { method: "ui/initialize", id: 7 }));
    const reply = posted(target).mock.calls[0][0];
    expect(reply.id).toBe(7);
    expect(reply.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["agentgem_get_session_data", "agentgem_invoke_agent"]);
    expect(reply.result).toHaveProperty("protocolVersion");
  });

  it("ignores a message whose source is not the target", async () => {
    const spy = vi.spyOn(playSessionDataRoute, "call").mockResolvedValue({ meta: {}, timeline: [] });
    const { host } = mkHost({ needs: ["session-data"] });
    host.handleMessage({ data: { jsonrpc: "2.0", method: "tools/call", id: 9, params: { name: "agentgem_get_session_data", arguments: {} } }, source: { other: true } } as unknown as MessageEvent);
    await tick();
    expect(spy).not.toHaveBeenCalled(); // e.source !== deps.target
  });
});

describe("mcpUiHost — per-call capability + consent gate", () => {
  it("rejects a tools/call whose capability ∉ needs and never calls the executor", async () => {
    const spy = vi.spyOn(inventoryRoute, "call").mockResolvedValue({ skills: [] } as never);
    const { host, target } = mkHost({ needs: ["session-data"] }); // NOT local-project-access
    host.handleMessage(msg(target, { method: "tools/call", id: 2, params: { name: "agentgem_get_inventory", arguments: {} } }));
    await tick();
    expect(spy).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 2, error: expect.anything() }), "*");
  });

  it("an AUTO session-data call executes WITHOUT requestConsent", async () => {
    const spy = vi.spyOn(playSessionDataRoute, "call").mockResolvedValue({ meta: {}, timeline: [] });
    const { host, target, requestConsent } = mkHost({ needs: ["session-data"] });
    host.handleMessage(msg(target, { method: "tools/call", id: 3, params: { name: "agentgem_get_session_data", arguments: {} } }));
    await tick();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.anything(), { query: { name: "g1" } });
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 3, result: { meta: {}, timeline: [] } }), "*");
  });

  it("ignores miniapp-supplied sessionId/agent on the session-data AUTO path (name-only, no session choice)", async () => {
    const spy = vi.spyOn(playSessionDataRoute, "call").mockResolvedValue({ meta: {}, timeline: [] });
    const { host, target } = mkHost({ needs: ["session-data"] });
    host.handleMessage(msg(target, { method: "tools/call", id: 13, params: { name: "agentgem_get_session_data", arguments: { sessionId: "evil", agent: "x" } } }));
    await tick();
    expect(spy).toHaveBeenCalledWith(expect.anything(), { query: { name: "g1" } }); // no sessionId/agent forwarded
  });

  it("a gated capability calls requestConsent and only executes on true", async () => {
    const spy = vi.spyOn(inventoryRoute, "call").mockResolvedValue({ skills: [] } as never);
    const { host, target, requestConsent } = mkHost({ needs: ["local-project-access"] });
    (requestConsent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    host.handleMessage(msg(target, { method: "tools/call", id: 4, params: { name: "agentgem_get_inventory", arguments: {} } }));
    await tick();
    expect(requestConsent).toHaveBeenCalledWith("local-project-access");
    expect(spy).not.toHaveBeenCalled(); // denied → no execution
    host.handleMessage(msg(target, { method: "tools/call", id: 5, params: { name: "agentgem_get_inventory", arguments: {} } }));
    await tick();
    expect(spy).toHaveBeenCalled();     // allowed → executes
  });
});

describe("mcpUiHost — streaming + generation + dispose", () => {
  it("a streaming subscribe pushes ui/notifications/tool-result chunks", async () => {
    vi.spyOn(watchStream, "fetchSessions").mockResolvedValue([sess("/f.jsonl")]);
    let emit: (e: unknown) => void = () => {};
    vi.spyOn(watchStream, "openWatchStream").mockImplementation((_a, _f, cb) => { emit = cb as (e: unknown) => void; return () => {}; });
    const { host, target } = mkHost({ needs: ["live-session-events"] });
    host.handleMessage(msg(target, { method: "tools/call", id: 6, params: { name: "agentgem_subscribe_sessions", arguments: {} } }));
    await tick();
    emit({ type: "event", index: 0 });
    expect(posted(target)).toHaveBeenCalledWith(
      expect.objectContaining({ method: "ui/notifications/tool-result", params: { toolName: "agentgem_subscribe_sessions", chunk: { type: "event", index: 0 } } }), "*");
  });

  it("invoke-agent opens a neutral chat (no miniapp field) and streams deltas back", async () => {
    let chatBody: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/agents")) return { ok: true, json: async () => ({ agents: [{ id: "claude", available: true }] }) };
      chatBody = init?.body as string;
      return { ok: true, json: async () => ({ chatId: "c1" }) };
    }) as unknown as typeof fetch);
    let onDelta: ((t: string) => void) | null = null;
    vi.spyOn(studioStream, "openStudioStream").mockImplementation((_a, _c, _m, h) => { onDelta = h.onDelta; return () => {}; });
    const { host, target } = mkHost({ needs: ["invoke-agent"] });
    host.handleMessage(msg(target, { method: "tools/call", id: 12, params: { name: "agentgem_invoke_agent", arguments: { message: "hello agent" } } }));
    await tick();
    expect(JSON.parse(chatBody!).miniapp).toBeUndefined(); // neutral, never gem-scoped
    expect(studioStream.openStudioStream).toHaveBeenCalledWith("", "c1", "hello agent", expect.anything());
    onDelta!("hi there");
    expect(posted(target)).toHaveBeenCalledWith(
      expect.objectContaining({ method: "ui/notifications/tool-result", params: { toolName: "agentgem_invoke_agent", chunk: { kind: "delta", text: "hi there" } } }), "*");
    vi.unstubAllGlobals();
  });

  it("bumpGeneration then a late executor result does NOT post a reply", async () => {
    let resolve!: (v: unknown) => void;
    vi.spyOn(playSessionDataRoute, "call").mockReturnValue(new Promise((r) => { resolve = r; }) as never);
    const { host, target } = mkHost({ needs: ["session-data"] });
    host.handleMessage(msg(target, { method: "tools/call", id: 1, params: { name: "agentgem_get_session_data", arguments: {} } }));
    await tick();
    host.bumpGeneration();               // game changed while the fetch was in flight
    resolve({ meta: {}, timeline: [] });
    await tick();
    expect(posted(target)).not.toHaveBeenCalledWith(expect.objectContaining({ id: 1, result: expect.anything() }), "*");
  });

  it("dispose closes open stream handles", async () => {
    vi.spyOn(watchStream, "fetchSessions").mockResolvedValue([sess("/f.jsonl")]);
    const close = vi.fn();
    vi.spyOn(watchStream, "openWatchStream").mockImplementation(() => close);
    const { host, target } = mkHost({ needs: ["live-session-events"] });
    host.handleMessage(msg(target, { method: "tools/call", id: 8, params: { name: "agentgem_subscribe_sessions", arguments: {} } }));
    await tick();
    host.dispose();
    expect(close).toHaveBeenCalled();
  });

  it("live-session-events idle releases the one-stream guard for a later retry", async () => {
    const fs = vi.spyOn(watchStream, "fetchSessions").mockResolvedValueOnce([]); // no sessions yet
    const open = vi.spyOn(watchStream, "openWatchStream").mockImplementation(() => () => {});
    const { host, target } = mkHost({ needs: ["live-session-events"] });
    host.handleMessage(msg(target, { method: "tools/call", id: 10, params: { name: "agentgem_subscribe_sessions", arguments: {} } }));
    await tick();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 10, result: { status: "idle" } }), "*");
    fs.mockResolvedValue([sess("/late.jsonl")]); // a session now exists; re-request must not be wedged
    host.handleMessage(msg(target, { method: "tools/call", id: 11, params: { name: "agentgem_subscribe_sessions", arguments: {} } }));
    await tick();
    expect(open).toHaveBeenCalledWith("", "/late.jsonl", expect.any(Function));
  });
});

describe("mcpUiHost — feedSessionData (host-initiated 'Replay yours' rebind)", () => {
  it("fetches the picked session and pushes it as a session-data notification", async () => {
    const spy = vi.spyOn(playSessionDataRoute, "call").mockResolvedValue({ meta: { picked: true }, timeline: [] });
    const { host, target } = mkHost({ needs: ["session-data"] });
    host.feedSessionData("s1", "codex");
    await tick();
    expect(spy).toHaveBeenCalledWith(expect.anything(), { query: { name: "g1", sessionId: "s1", agent: "codex" } });
    expect(posted(target)).toHaveBeenCalledWith(
      expect.objectContaining({ method: "ui/notifications/tool-result", params: { toolName: "agentgem_get_session_data", chunk: { meta: { picked: true }, timeline: [] } } }), "*");
  });

  it("suppresses a second concurrent feedSessionData call", async () => {
    let resolve!: (v: unknown) => void;
    const spy = vi.spyOn(playSessionDataRoute, "call").mockReturnValue(new Promise((r) => { resolve = r; }) as never);
    const { host } = mkHost({ needs: ["session-data"] });
    host.feedSessionData("s1", "codex");
    host.feedSessionData("s2", "claude"); // in-flight — suppressed by the single-flight guard
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
    resolve({ meta: {}, timeline: [] });
    await tick();
  });

  it("bumpGeneration then a late feedSessionData result does NOT post a notification", async () => {
    let resolve!: (v: unknown) => void;
    vi.spyOn(playSessionDataRoute, "call").mockReturnValue(new Promise((r) => { resolve = r; }) as never);
    const { host, target } = mkHost({ needs: ["session-data"] });
    host.feedSessionData("s1", "codex");
    await tick();
    host.bumpGeneration();               // game changed while the fetch was in flight
    resolve({ meta: {}, timeline: [] });
    await tick();
    expect(posted(target)).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "ui/notifications/tool-result", params: expect.objectContaining({ toolName: "agentgem_get_session_data" }) }), "*");
  });
});
