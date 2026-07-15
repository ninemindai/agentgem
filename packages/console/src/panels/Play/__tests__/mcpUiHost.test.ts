// packages/console/src/panels/Play/__tests__/mcpUiHost.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { playSessionDataRoute, inventoryRoute } from "../../../api/routes.js";
import * as watchStream from "../../Watch/watchStream.js";
import * as hygieneStream from "../../Watch/hygieneStream.js";
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
    expect(reply.result._meta["ai.agentgem/host"].tools.map((t: { name: string }) => t.name).sort()).toEqual(["agentgem_get_session_data", "agentgem_invoke_agent"]);
    expect(reply.result).toHaveProperty("protocolVersion");
  });

  it("ui/initialize reply is spec-shaped (no top-level tools, tools under _meta)", () => {
    const posted: any[] = [];
    const target = { postMessage: (m: any) => posted.push(m) } as any;
    const host = createUiHost({ apiBase: "", name: "g", needs: ["session-data"], interactive: true, target, requestConsent: async () => true });
    host.handleMessage({ source: target, data: { jsonrpc: "2.0", id: 1, method: "ui/initialize" } } as any);
    const r = posted[0].result;
    expect(r).toHaveProperty("hostInfo");
    expect(r).toHaveProperty("hostCapabilities");
    expect(r).not.toHaveProperty("tools");
    expect(r._meta["ai.agentgem/host"].tools.length).toBeGreaterThan(0);
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
      expect.objectContaining({
        method: "ui/notifications/tool-result",
        params: { content: [], structuredContent: { type: "event", index: 0 }, _meta: { "ai.agentgem/stream": { toolName: "agentgem_subscribe_sessions" } } },
      }), "*");
  });

  it("context-hygiene subscribe opens the hygiene stream and pushes events as tool-result chunks", async () => {
    vi.spyOn(watchStream, "fetchSessions").mockResolvedValue([sess("/f.jsonl")]);
    let emit: (e: unknown) => void = () => {};
    vi.spyOn(hygieneStream, "openHygieneStream").mockImplementation((_a, _f, cb) => { emit = cb as (e: unknown) => void; return () => {}; });
    const { host, target } = mkHost({ needs: ["context-hygiene"] });
    host.handleMessage(msg(target, { method: "tools/call", id: 21, params: { name: "agentgem_subscribe_hygiene", arguments: {} } }));
    await tick();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 21, result: { status: "subscribed" } }), "*");
    const evt = { type: "hygiene", verdict: "bounded", score: 5, cap: 200000, curveTail: [{ turn: 3, msgIndex: 6, ctxTokens: 42000, cacheCreation: 0, outTokens: 0 }], factors: [] };
    emit(evt);
    expect(posted(target)).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "ui/notifications/tool-result",
        params: { content: [], structuredContent: evt, _meta: { "ai.agentgem/stream": { toolName: "agentgem_subscribe_hygiene" } } },
      }), "*");
  });

  it("context-hygiene idle (no session) releases the guard for a later retry", async () => {
    const fs = vi.spyOn(watchStream, "fetchSessions").mockResolvedValueOnce([]);
    const open = vi.spyOn(hygieneStream, "openHygieneStream").mockImplementation(() => () => {});
    const { host, target } = mkHost({ needs: ["context-hygiene"] });
    host.handleMessage(msg(target, { method: "tools/call", id: 22, params: { name: "agentgem_subscribe_hygiene", arguments: {} } }));
    await tick();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 22, result: { status: "idle" } }), "*");
    fs.mockResolvedValueOnce([sess("/f.jsonl")]);
    host.handleMessage(msg(target, { method: "tools/call", id: 23, params: { name: "agentgem_subscribe_hygiene", arguments: {} } }));
    await tick();
    expect(open).toHaveBeenCalled();  // guard was released, retry subscribed
  });

  it("rebindHygiene closes ONLY the current hygiene stream and opens one on the picked file", async () => {
    vi.spyOn(watchStream, "fetchSessions").mockResolvedValue([sess("/auto.jsonl")]);
    const opened: string[] = [];
    const closed: string[] = [];
    let emit: (e: unknown) => void = () => {};
    vi.spyOn(hygieneStream, "openHygieneStream").mockImplementation((_a, file, cb) => {
      opened.push(file); emit = cb as (e: unknown) => void;
      return () => { closed.push(file); };
    });
    const { host, target } = mkHost({ needs: ["context-hygiene"] });
    host.handleMessage(msg(target, { method: "tools/call", id: 31, params: { name: "agentgem_subscribe_hygiene", arguments: {} } }));
    await tick();
    expect(opened).toEqual(["/auto.jsonl"]);   // auto-subscribe = most-recent session

    host.rebindHygiene("/picked.jsonl");
    await tick();
    expect(closed).toEqual(["/auto.jsonl"]);   // old stream closed, nothing else
    expect(opened).toEqual(["/auto.jsonl", "/picked.jsonl"]);

    // events from the rebound stream flow over the SAME notification channel the game already consumes
    const evt = { type: "hygiene", verdict: "bounded" };
    emit(evt);
    expect(posted(target)).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "ui/notifications/tool-result",
        params: { content: [], structuredContent: evt, _meta: { "ai.agentgem/stream": { toolName: "agentgem_subscribe_hygiene" } } },
      }), "*");
  });

  it("rebindHygiene is a no-op for a game that never declared context-hygiene", async () => {
    const open = vi.spyOn(hygieneStream, "openHygieneStream").mockImplementation(() => () => {});
    const { host } = mkHost({ needs: ["session-data"] });
    host.rebindHygiene("/f.jsonl");
    await tick();
    expect(open).not.toHaveBeenCalled();
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
      expect.objectContaining({
        method: "ui/notifications/tool-result",
        params: { content: [], structuredContent: { kind: "delta", text: "hi there" }, _meta: { "ai.agentgem/stream": { toolName: "agentgem_invoke_agent" } } },
      }), "*");
    vi.unstubAllGlobals();
  });

  it("invoke-agent releases chatPromise on chat-open rejection so a later invoke retries", async () => {
    let chatCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/api/agents")) return { ok: true, json: async () => ({ agents: [{ id: "claude", available: true }] }) };
      chatCalls++;
      if (chatCalls === 1) throw new Error("chat-open failed"); // first invoke: chat-open rejects
      return { ok: true, json: async () => ({ chatId: "c1" }) };  // second invoke: chat-open succeeds
    }) as unknown as typeof fetch);
    vi.spyOn(studioStream, "openStudioStream").mockImplementation(() => () => {});
    const { host, target } = mkHost({ needs: ["invoke-agent"] });

    // First invoke-agent: chat-open rejects -> the outer catch replies a JSON-RPC error.
    host.handleMessage(msg(target, { method: "tools/call", id: 20, params: { name: "agentgem_invoke_agent", arguments: { message: "hi" } } }));
    await tick();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 20, error: expect.anything() }), "*");
    expect(chatCalls).toBe(1);

    // Second invoke-agent: chatPromise must have been released (not left pointing at the rejected
    // promise), so chat-open is attempted AGAIN rather than re-awaiting the same rejection forever.
    host.handleMessage(msg(target, { method: "tools/call", id: 21, params: { name: "agentgem_invoke_agent", arguments: { message: "hi again" } } }));
    await tick();
    expect(chatCalls).toBe(2); // retried the chat-open — proves chatPromise was reset
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 21, result: { status: "invoking" } }), "*");
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

describe("mcpUiHost — action capabilities (open-link / send-message / update-model-context)", () => {
  it("ui/open-link with the cap declared + consent granted calls openExternal and replies {}", async () => {
    const openExternal = vi.fn();
    const { host, target, requestConsent } = mkHost({ needs: ["open-link"], openExternal });
    host.handleMessage(msg(target, { method: "ui/open-link", id: 30, params: { url: "https://x.test" } }));
    await tick();
    expect(requestConsent).toHaveBeenCalledWith("open-link", "https://x.test");
    expect(openExternal).toHaveBeenCalledWith("https://x.test");
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 30, result: {} }), "*");
  });

  it("ui/open-link with the cap NOT in needs replies -32601", async () => {
    const openExternal = vi.fn();
    const { host, target, requestConsent } = mkHost({ needs: ["session-data"], openExternal });
    host.handleMessage(msg(target, { method: "ui/open-link", id: 31, params: { url: "https://x.test" } }));
    await tick();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 31, error: expect.objectContaining({ code: -32601 }) }), "*");
  });

  it("ui/open-link with consent denied replies -32001 and does not call openExternal", async () => {
    const openExternal = vi.fn();
    const requestConsent = vi.fn(async () => false);
    const { host, target } = mkHost({ needs: ["open-link"], openExternal, requestConsent });
    host.handleMessage(msg(target, { method: "ui/open-link", id: 32, params: { url: "https://x.test" } }));
    await tick();
    expect(openExternal).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 32, error: expect.objectContaining({ code: -32001 } ) }), "*");
  });

  it("ui/open-link rejects a non-http(s) url with -32602 invalid params", async () => {
    const openExternal = vi.fn();
    const { host, target, requestConsent } = mkHost({ needs: ["open-link"], openExternal });
    host.handleMessage(msg(target, { method: "ui/open-link", id: 33, params: { url: "javascript:alert(1)" } }));
    await tick();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 33, error: expect.objectContaining({ code: -32602 }) }), "*");
  });

  it("ui/copy-command with the cap + consent granted copies the text and replies {}", async () => {
    const copyText = vi.fn();
    const { host, target, requestConsent } = mkHost({ needs: ["copy-command"], copyText });
    host.handleMessage(msg(target, { method: "ui/copy-command", id: 40, params: { text: "/compact" } }));
    await tick();
    expect(requestConsent).toHaveBeenCalledWith("copy-command", "/compact");
    expect(copyText).toHaveBeenCalledWith("/compact");
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 40, result: {} }), "*");
  });

  it("ui/copy-command with consent denied does not copy and replies -32001", async () => {
    const copyText = vi.fn();
    const { host, target } = mkHost({ needs: ["copy-command"], copyText, requestConsent: vi.fn(async () => false) });
    host.handleMessage(msg(target, { method: "ui/copy-command", id: 41, params: { text: "/compact" } }));
    await tick();
    expect(copyText).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 41, error: expect.objectContaining({ code: -32001 }) }), "*");
  });

  it("ui/copy-command with the cap NOT in needs replies -32601", async () => {
    const copyText = vi.fn();
    const { host, target, requestConsent } = mkHost({ needs: ["session-data"], copyText });
    host.handleMessage(msg(target, { method: "ui/copy-command", id: 42, params: { text: "/compact" } }));
    await tick();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(copyText).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 42, error: expect.objectContaining({ code: -32601 }) }), "*");
  });

  it("ui/copy-command rejects over-length / empty text with -32602", async () => {
    const copyText = vi.fn();
    const { host, target, requestConsent } = mkHost({ needs: ["copy-command"], copyText });
    host.handleMessage(msg(target, { method: "ui/copy-command", id: 43, params: { text: "x".repeat(257) } }));
    await tick();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(copyText).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 43, error: expect.objectContaining({ code: -32602 }) }), "*");
  });

  it("ui/message with the cap declared replies -32601 'unsupported by this host'", async () => {
    const { host, target, requestConsent } = mkHost({ needs: ["send-message"] });
    host.handleMessage(msg(target, { method: "ui/message", id: 34, params: { role: "user", content: "hi" } }));
    await tick();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 34, error: { code: -32601, message: "unsupported by this host" } }), "*");
  });

  it("ui/message with the cap NOT in needs replies -32601 'capability not permitted'", async () => {
    const { host, target } = mkHost({ needs: ["session-data"] });
    host.handleMessage(msg(target, { method: "ui/message", id: 35, params: { role: "user", content: "hi" } }));
    await tick();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 35, error: expect.objectContaining({ code: -32601, message: expect.stringContaining("capability not permitted") }) }), "*");
  });

  it("ui/update-model-context with the cap declared replies -32601 'unsupported by this host'", async () => {
    const { host, target } = mkHost({ needs: ["update-model-context"] });
    host.handleMessage(msg(target, { method: "ui/update-model-context", id: 36, params: { state: {} } }));
    await tick();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 36, error: { code: -32601, message: "unsupported by this host" } }), "*");
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
      expect.objectContaining({
        method: "ui/notifications/tool-result",
        params: { content: [], structuredContent: { meta: { picked: true }, timeline: [] }, _meta: { "ai.agentgem/stream": { toolName: "agentgem_get_session_data" } } },
      }), "*");
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
      expect.objectContaining({
        method: "ui/notifications/tool-result",
        params: expect.objectContaining({ _meta: { "ai.agentgem/stream": { toolName: "agentgem_get_session_data" } } }),
      }), "*");
  });

  it("bumpGeneration resets the feeding guard, allowing a new feedSessionData after pending", async () => {
    let resolve1!: (v: unknown) => void;
    const spy = vi.spyOn(playSessionDataRoute, "call")
      .mockReturnValueOnce(new Promise((r) => { resolve1 = r; }) as never) // first call: pending
      .mockResolvedValueOnce({ meta: { picked: true }, timeline: [] });   // second call: resolved
    const { host, target } = mkHost({ needs: ["session-data"] });
    host.feedSessionData("s1", "codex");
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
    host.bumpGeneration();               // resets feeding guard
    host.feedSessionData("s2", "claude"); // should now proceed (not dropped)
    await tick();
    expect(spy).toHaveBeenCalledTimes(2); // new call is invoked
    expect(spy).toHaveBeenNthCalledWith(2, expect.anything(), { query: { name: "g1", sessionId: "s2", agent: "claude" } });
    resolve1({ meta: {}, timeline: [] }); // resolve first (stale) call — should not post
    await tick();
    // Should have posted only the second (new) result
    expect(posted(target)).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "ui/notifications/tool-result",
        params: { content: [], structuredContent: { meta: { picked: true }, timeline: [] }, _meta: { "ai.agentgem/stream": { toolName: "agentgem_get_session_data" } } },
      }), "*");
  });
});
