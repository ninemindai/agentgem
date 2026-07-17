// src/play/__tests__/mcpAppClient.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { mcpAppClient, MCP_CLIENT_MARKER } from "@agentgem/play";

// A tiny two-window harness. The shim runs against `child` (its `window`); it posts to `child.parent`
// (the host). The host "responds" by delivering a MessageEvent-shaped object back into `child`, with
// source = parent — exactly what the shim's `e.source === window.parent` gate requires. No jsdom needed:
// the shim touches window.parent / window.addEventListener / window.agentgemApp, plus (since PR 3)
// document.documentElement for theme/style application — all injected here. ResizeObserver and
// window.innerWidth are deliberately left unmocked: they're absent in this Node harness the same way
// they'd be present in a real browser, so `typeof ResizeObserver === "undefined"` short-circuits
// maybeObserveSize before it would need them.
type Win = {
  parent: unknown;
  document: { documentElement: { setAttribute(k: string, v: string): void; style: { setProperty(k: string, v: string): void } } };
  agentgemApp: {
    ready: boolean; hostTools: unknown[];
    callTool(n: string, a?: unknown): Promise<unknown>;
    openLink(url: string): Promise<unknown>;
    sendMessage(params: unknown): Promise<unknown>;
    updateModelContext(params: unknown): Promise<unknown>;
    requestDisplayMode(mode: string): Promise<unknown>;
    onNotification(m: string, cb: (x: unknown) => void): void;
    mcp: {
      callTool(server: string, tool: string, input?: unknown): Promise<{ payload: unknown; content: unknown }>;
      listTools(): Promise<unknown>;
    };
  };
  addEventListener(type: string, cb: (e: { data: unknown; source: unknown }) => void): void;
  removeEventListener(type: string, cb: (e: { data: unknown; source: unknown }) => void): void;
  deliver(data: unknown, source: unknown): void;
  postMessage(msg: { jsonrpc?: string; id?: number; method?: string; params?: unknown }): void;
};

function makeWindow(): Win {
  const listeners: Array<(e: { data: unknown; source: unknown }) => void> = [];
  return {
    parent: null,
    document: { documentElement: { setAttribute() { /* no-op */ }, style: { setProperty() { /* no-op */ } } } },
    agentgemApp: undefined as never,
    addEventListener(type, cb) { if (type === "message") listeners.push(cb); },
    removeEventListener(_type, cb) { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); },
    deliver(data, source) { for (const cb of listeners.slice()) cb({ data, source }); },
    postMessage: undefined as never,
  };
}

function runShim(win: Win): void {
  const body = mcpAppClient().replace(/<\/?script>/g, "");
  // The shim references `window` and (since PR 3) `document`, resolved via these Function parameters
  // (browser: both are globals; here, `document` is `win.document`, distinct per two-window harness).
  new Function("window", "document", body)(win, win.document);
}

describe("mcpAppClient shim", () => {
  it("retries ui/initialize to defeat the host attach-race, then round-trips a tool call + notifications", async () => {
    const child = makeWindow();
    const parent = makeWindow();
    child.parent = parent;

    let initCount = 0;
    const toolCalls: Array<{ id?: number; params?: unknown }> = [];
    // The host side: child's posts land here. Ignore the FIRST ui/initialize (host "not attached yet");
    // only answer the retry — so a passing test PROVES the shim resent the handshake.
    parent.postMessage = (msg) => {
      if (msg.method === "ui/initialize") {
        initCount++;
        if (initCount >= 2) child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", _meta: { "ai.agentgem/host": { tools: [{ name: "agentgem_get_session_data" }] } } } }, parent);
        return;
      }
      if (msg.method === "ui/notifications/initialized") return;
      if (msg.method === "tools/call") { toolCalls.push(msg); child.deliver({ jsonrpc: "2.0", id: msg.id, result: { echoed: msg.params } }, parent); return; }
    };

    runShim(child);
    expect(child.agentgemApp).toBeTruthy();
    expect(child.agentgemApp.ready).toBe(false); // first init unanswered
    expect(initCount).toBe(1);

    await new Promise((r) => setTimeout(r, 900)); // past one ~800ms retry tick
    expect(initCount).toBeGreaterThanOrEqual(2); // RETRIED
    expect(child.agentgemApp.ready).toBe(true);
    expect(child.agentgemApp.hostTools).toEqual([{ name: "agentgem_get_session_data" }]);

    const res = await child.agentgemApp.callTool("agentgem_get_session_data", { sessionId: "s1" });
    expect(res).toEqual({ echoed: { name: "agentgem_get_session_data", arguments: { sessionId: "s1" } } });

    // Real callers (scaffolds.ts, migrate.ts) subscribe by the JSON-RPC METHOD, not the tool name, and
    // filter on `p.toolName` inside the callback — the shim must dispatch on `d.method`, not
    // `d.params.toolName`, or every real miniapp silently drops host-pushed notifications.
    const chunks: unknown[] = [];
    child.agentgemApp.onNotification("ui/notifications/tool-result", (m) => chunks.push(m));
    child.deliver(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { content: [], structuredContent: { type: "event" }, _meta: { "ai.agentgem/stream": { toolName: "agentgem_subscribe_sessions" } } },
      },
      parent,
    );
    expect(chunks).toEqual([{ toolName: "agentgem_subscribe_sessions", chunk: { type: "event" } }]);
  });

  it("dispatches to a method-keyed subscriber the way the real scaffold/migrate callers do, filtering by toolName in the callback", async () => {
    // Mirrors scaffolds.ts:100 and migrate.ts's NEW_FEED_LISTENER verbatim: subscribe once on the
    // method, and let the callback itself decide which tool's chunk it cares about.
    const child = makeWindow();
    const parent = makeWindow();
    child.parent = parent;
    parent.postMessage = (msg) => {
      if (msg.method === "ui/initialize") child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", _meta: { "ai.agentgem/host": { tools: [] } } } }, parent);
    };
    runShim(child);

    const received: Array<{ toolName: string; chunk: unknown }> = [];
    child.agentgemApp.onNotification("ui/notifications/tool-result", (p) => {
      const params = p as { toolName: string; chunk: unknown };
      if (params.toolName === "agentgem_get_session_data") received.push(params);
    });

    child.deliver(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { content: [], structuredContent: { meta: {}, timeline: [] }, _meta: { "ai.agentgem/stream": { toolName: "agentgem_get_session_data" } } },
      },
      parent,
    );

    expect(received).toEqual([{ toolName: "agentgem_get_session_data", chunk: { meta: {}, timeline: [] } }]);
  });

  it("ignores messages whose source is not the host parent", () => {
    const child = makeWindow();
    const parent = makeWindow();
    child.parent = parent;
    parent.postMessage = () => {};
    runShim(child);
    child.deliver({ jsonrpc: "2.0", id: 1, result: { tools: [] } }, { not: "the-parent" }); // foreign source
    expect(child.agentgemApp.ready).toBe(false);
  });

  it("carries the MCP_CLIENT_MARKER for migration idempotence", () => {
    expect(MCP_CLIENT_MARKER).toBe("agentgem:mcp-app-client:2");
    expect(mcpAppClient()).toContain(MCP_CLIENT_MARKER);
  });

  describe("action capability methods (open-link / send-message / update-model-context)", () => {
    it("openLink posts a ui/open-link request with params:{url} and resolves on the host's reply", async () => {
      const child = makeWindow();
      const parent = makeWindow();
      child.parent = parent;
      const posted: Array<{ jsonrpc?: string; id?: number; method?: string; params?: unknown }> = [];
      parent.postMessage = (msg) => {
        posted.push(msg);
        if (msg.method === "ui/initialize") { child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", _meta: { "ai.agentgem/host": { tools: [] } } } }, parent); return; }
        if (msg.method === "ui/open-link") { child.deliver({ jsonrpc: "2.0", id: msg.id, result: {} }, parent); return; }
      };
      runShim(child);
      expect(child.agentgemApp.ready).toBe(true);

      const result = await child.agentgemApp.openLink("https://x.test");
      expect(posted).toContainEqual(expect.objectContaining({ method: "ui/open-link", params: { url: "https://x.test" } }));
      expect(result).toEqual({});
    });

    it("sendMessage posts a ui/message request with the given params and resolves on the host's reply", async () => {
      const child = makeWindow();
      const parent = makeWindow();
      child.parent = parent;
      const posted: Array<{ jsonrpc?: string; id?: number; method?: string; params?: unknown }> = [];
      parent.postMessage = (msg) => {
        posted.push(msg);
        if (msg.method === "ui/initialize") { child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", _meta: { "ai.agentgem/host": { tools: [] } } } }, parent); return; }
        if (msg.method === "ui/message") { child.deliver({ jsonrpc: "2.0", id: msg.id, result: {} }, parent); return; }
      };
      runShim(child);
      expect(child.agentgemApp.ready).toBe(true);

      const params = { role: "user", content: "hi" };
      const result = await child.agentgemApp.sendMessage(params);
      expect(posted).toContainEqual(expect.objectContaining({ method: "ui/message", params }));
      expect(result).toEqual({});
    });

    it("updateModelContext posts a ui/update-model-context request with the given params and resolves on the host's reply", async () => {
      const child = makeWindow();
      const parent = makeWindow();
      child.parent = parent;
      const posted: Array<{ jsonrpc?: string; id?: number; method?: string; params?: unknown }> = [];
      parent.postMessage = (msg) => {
        posted.push(msg);
        if (msg.method === "ui/initialize") { child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", _meta: { "ai.agentgem/host": { tools: [] } } } }, parent); return; }
        if (msg.method === "ui/update-model-context") { child.deliver({ jsonrpc: "2.0", id: msg.id, result: {} }, parent); return; }
      };
      runShim(child);
      expect(child.agentgemApp.ready).toBe(true);

      const params = { state: { score: 3 } };
      const result = await child.agentgemApp.updateModelContext(params);
      expect(posted).toContainEqual(expect.objectContaining({ method: "ui/update-model-context", params }));
      expect(result).toEqual({});
    });

    it("requestDisplayMode posts a ui/request-display-mode request with params:{mode} and resolves with the host's reply", async () => {
      const child = makeWindow();
      const parent = makeWindow();
      child.parent = parent;
      const posted: Array<{ jsonrpc?: string; id?: number; method?: string; params?: unknown }> = [];
      parent.postMessage = (msg) => {
        posted.push(msg);
        if (msg.method === "ui/initialize") { child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", _meta: { "ai.agentgem/host": { tools: [] } } } }, parent); return; }
        // The host may refuse and apply a different mode than requested — reply with what it actually applied.
        if (msg.method === "ui/request-display-mode") { child.deliver({ jsonrpc: "2.0", id: msg.id, result: { mode: "fullscreen" } }, parent); return; }
      };
      runShim(child);
      expect(child.agentgemApp.ready).toBe(true);

      const result = await child.agentgemApp.requestDisplayMode("fullscreen");
      expect(posted).toContainEqual(expect.objectContaining({ method: "ui/request-display-mode", params: { mode: "fullscreen" } }));
      expect(result).toEqual({ mode: "fullscreen" });
    });

    it("rejects a queued openLink call before ui/initialize once the handshake retries are exhausted (proves callTool's queue-gating is shared, not duplicated)", async () => {
      vi.useFakeTimers();
      const child = makeWindow();
      const parent = makeWindow();
      child.parent = parent;
      parent.postMessage = () => {}; // no host reply, ever
      runShim(child);

      const promise = child.agentgemApp.openLink("https://x.test");
      const assertion = expect(promise).rejects.toThrow(/no host/);
      await vi.advanceTimersByTimeAsync(6 * 800 + 100);
      await assertion;
      vi.useRealTimers();
    });
  });

  describe("mcp connectors (agentgemApp.mcp.callTool / listTools)", () => {
    it("callTool posts mcp/call with {server,tool,input} and resolves {payload,content} when the envelope is ok", async () => {
      const child = makeWindow();
      const parent = makeWindow();
      child.parent = parent;
      const posted: Array<{ jsonrpc?: string; id?: number; method?: string; params?: unknown }> = [];
      parent.postMessage = (msg) => {
        posted.push(msg);
        if (msg.method === "ui/initialize") { child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", _meta: { "ai.agentgem/host": { tools: [] } } } }, parent); return; }
        if (msg.method === "mcp/call") {
          child.deliver({ jsonrpc: "2.0", id: msg.id, result: { ok: true, payload: { count: 1 }, content: [{ type: "text", text: "one PR" }] } }, parent);
          return;
        }
      };
      runShim(child);
      expect(child.agentgemApp.ready).toBe(true);

      const result = await child.agentgemApp.mcp.callTool("github", "list_pull_requests", { repo: "x" });
      expect(posted).toContainEqual(expect.objectContaining({ method: "mcp/call", params: { server: "github", tool: "list_pull_requests", input: { repo: "x" } } }));
      expect(result).toEqual({ payload: { count: 1 }, content: [{ type: "text", text: "one PR" }] });
    });

    it("callTool throws an Error with .code (not just message) when the envelope is {ok:false, error}", async () => {
      const child = makeWindow();
      const parent = makeWindow();
      child.parent = parent;
      parent.postMessage = (msg) => {
        if (msg.method === "ui/initialize") { child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", _meta: { "ai.agentgem/host": { tools: [] } } } }, parent); return; }
        if (msg.method === "mcp/call") {
          child.deliver({ jsonrpc: "2.0", id: msg.id, result: { ok: false, error: { code: "not_granted", message: "consent denied" } } }, parent);
          return;
        }
      };
      runShim(child);

      let caught: unknown;
      try { await child.agentgemApp.mcp.callTool("github", "list_pull_requests"); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("consent denied");
      expect((caught as Error & { code?: string }).code).toBe("not_granted");
    });

    it("listTools posts mcp/list with empty params and resolves the host's reply verbatim", async () => {
      const child = makeWindow();
      const parent = makeWindow();
      child.parent = parent;
      const posted: Array<{ jsonrpc?: string; id?: number; method?: string; params?: unknown }> = [];
      const serversReply = { servers: [{ server: "github", tools: ["list_pull_requests"], status: "granted" }] };
      parent.postMessage = (msg) => {
        posted.push(msg);
        if (msg.method === "ui/initialize") { child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", _meta: { "ai.agentgem/host": { tools: [] } } } }, parent); return; }
        if (msg.method === "mcp/list") { child.deliver({ jsonrpc: "2.0", id: msg.id, result: serversReply }, parent); return; }
      };
      runShim(child);

      const result = await child.agentgemApp.mcp.listTools();
      expect(posted).toContainEqual(expect.objectContaining({ method: "mcp/list", params: {} }));
      expect(result).toEqual(serversReply);
    });
  });

  it("replies to a ui/resource-teardown request with an empty JSON-RPC result", () => {
    const child = makeWindow();
    const parent = makeWindow();
    child.parent = parent;
    const posted: Array<{ jsonrpc?: string; id?: number; method?: string; result?: unknown }> = [];
    parent.postMessage = (msg) => { posted.push(msg); };
    runShim(child);
    posted.length = 0; // drop the initial ui/initialize the shim posts on load

    child.deliver({ jsonrpc: "2.0", id: 7, method: "ui/resource-teardown" }, parent);

    expect(posted).toContainEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("routes an inbound ui/resource-teardown REQUEST by method, not id, even when the host's id-space collides with an in-flight callTool id", async () => {
    // ui/resource-teardown is the first id-bearing inbound REQUEST the shim ever sees — every prior
    // id-bearing inbound message was a RESPONSE to the shim's own request. The host picks the
    // teardown id from its own id-space, which can collide with the shim's tools/call ids (the shim's
    // start at 1). A response-branch match on id alone would intercept the teardown, resolve the
    // in-flight callTool with `undefined` (a request has no `.result`), and never post the teardown
    // reply — the host hangs waiting for it and the game gets a spurious tool result.
    const child = makeWindow();
    const parent = makeWindow();
    child.parent = parent;
    const posted: Array<{ jsonrpc?: string; id?: number; method?: string; result?: unknown }> = [];
    let toolCallId: number | undefined;
    parent.postMessage = (msg) => {
      posted.push(msg);
      if (msg.method === "ui/initialize") { child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", _meta: { "ai.agentgem/host": { tools: [] } } } }, parent); return; }
      if (msg.method === "tools/call") { toolCallId = msg.id; } // host holds the call in flight, no reply yet
    };
    runShim(child);
    expect(child.agentgemApp.ready).toBe(true);

    const promise = child.agentgemApp.callTool("agentgem_get_session_data");
    expect(toolCallId).toBeDefined();
    posted.length = 0;

    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });

    // The host's teardown request id collides with the in-flight tools/call id above.
    child.deliver({ jsonrpc: "2.0", id: toolCallId, method: "ui/resource-teardown" }, parent);

    await new Promise((r) => setTimeout(r, 0)); // flush microtasks so a wrongly-resolved promise would show up

    expect(posted).toContainEqual({ jsonrpc: "2.0", id: toolCallId, result: {} }); // teardown reply posted
    expect(settled).toBe(false); // the in-flight callTool must still be pending, NOT resolved with undefined
  });

  it("dispatches ui/notifications/tool-input with params.arguments", () => {
    const child = makeWindow();
    const parent = makeWindow();
    child.parent = parent;
    parent.postMessage = (msg) => { if (msg.method === "ui/initialize") child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", _meta: { "ai.agentgem/host": { tools: [] } } } }, parent); };
    runShim(child);

    const received: unknown[] = [];
    child.agentgemApp.onNotification("ui/notifications/tool-input", (p) => received.push(p));
    child.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { level: 3 } } }, parent);

    expect(received).toEqual([{ level: 3 }]);
  });

  it("dispatches ui/notifications/tool-cancelled with params as-is", () => {
    const child = makeWindow();
    const parent = makeWindow();
    child.parent = parent;
    parent.postMessage = (msg) => { if (msg.method === "ui/initialize") child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", _meta: { "ai.agentgem/host": { tools: [] } } } }, parent); };
    runShim(child);

    const received: unknown[] = [];
    child.agentgemApp.onNotification("ui/notifications/tool-cancelled", (p) => received.push(p));
    child.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-cancelled", params: { toolCallId: "abc" } }, parent);

    expect(received).toEqual([{ toolCallId: "abc" }]);
  });

  it("dispatches ui/notifications/host-context-changed with params as-is", () => {
    const child = makeWindow();
    const parent = makeWindow();
    child.parent = parent;
    parent.postMessage = (msg) => { if (msg.method === "ui/initialize") child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", _meta: { "ai.agentgem/host": { tools: [] } } } }, parent); };
    runShim(child);

    const received: unknown[] = [];
    child.agentgemApp.onNotification("ui/notifications/host-context-changed", (p) => received.push(p));
    child.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark" } }, parent);

    expect(received).toEqual([{ theme: "dark" }]);
  });

  describe("callTool ready-gating", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("queues a callTool made before ui/initialize resolves, then posts it once ready and resolves on reply", async () => {
      vi.useFakeTimers();
      const child = makeWindow();
      const parent = makeWindow();
      child.parent = parent;
      const toolCalls: Array<{ id?: number; params?: unknown }> = [];
      let deliverInit: (() => void) | null = null;
      parent.postMessage = (msg) => {
        if (msg.method === "ui/initialize") { deliverInit = () => child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", _meta: { "ai.agentgem/host": { tools: [] } } } }, parent); return; }
        if (msg.method === "tools/call") { toolCalls.push(msg); child.deliver({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }, parent); return; }
      };
      runShim(child);

      // Called before the host has answered ui/initialize — must NOT post yet (would be lost pre-attach).
      const promise = child.agentgemApp.callTool("agentgem_get_session_data");
      expect(toolCalls.length).toBe(0);
      expect(child.agentgemApp.ready).toBe(false);

      deliverInit!(); // the (first) ui/initialize now resolves
      expect(child.agentgemApp.ready).toBe(true);
      expect(toolCalls.length).toBe(1); // flushed on ready

      await expect(promise).resolves.toEqual({ ok: true });
    });

    it("rejects a queued callTool with 'no host' once the handshake retries are exhausted", async () => {
      vi.useFakeTimers();
      const child = makeWindow();
      const parent = makeWindow();
      child.parent = parent;
      parent.postMessage = () => {}; // no host reply, ever — e.g. sealed no-host marketplace case
      runShim(child);

      const promise = child.agentgemApp.callTool("agentgem_get_session_data");
      const assertion = expect(promise).rejects.toThrow(/no host/);

      await vi.advanceTimersByTimeAsync(6 * 800 + 100); // past all 5 retries (~800ms apart) to the exhaustion tick

      await assertion;
      expect(child.agentgemApp.ready).toBe(false);
    });

    it("does not prematurely reject a posted (ready) callTool even long after a fixed 10s timeout would have fired", async () => {
      vi.useFakeTimers();
      const child = makeWindow();
      const parent = makeWindow();
      child.parent = parent;
      let toolCallMsg: { id?: number } | null = null;
      parent.postMessage = (msg) => {
        if (msg.method === "ui/initialize") { child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", _meta: { "ai.agentgem/host": { tools: [] } } } }, parent); return; }
        if (msg.method === "tools/call") toolCallMsg = msg; // host holds the call — e.g. slow user consent
      };
      runShim(child);
      expect(child.agentgemApp.ready).toBe(true);

      const promise = child.agentgemApp.callTool("agentgem_get_inventory");
      expect(toolCallMsg).toBeTruthy(); // posted immediately since already ready

      let settled = false;
      promise.then(() => { settled = true; }, () => { settled = true; });

      await vi.advanceTimersByTimeAsync(60000); // well past the old fixed 10s timeout
      expect(settled).toBe(false); // still pending — consent-safe, no fixed timeout to fire

      child.deliver({ jsonrpc: "2.0", id: toolCallMsg!.id, result: { allowed: true } }, parent);
      await expect(promise).resolves.toEqual({ allowed: true });
    });
  });
});
