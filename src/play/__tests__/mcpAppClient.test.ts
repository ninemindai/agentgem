// src/play/__tests__/mcpAppClient.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { mcpAppClient, MCP_CLIENT_MARKER } from "@agentgem/play";

// A tiny two-window harness. The shim runs against `child` (its `window`); it posts to `child.parent`
// (the host). The host "responds" by delivering a MessageEvent-shaped object back into `child`, with
// source = parent — exactly what the shim's `e.source === window.parent` gate requires. No jsdom needed:
// the shim only touches window.parent / window.addEventListener / window.agentgemApp, all injected here.
type Win = {
  parent: unknown;
  agentgemApp: { ready: boolean; hostTools: unknown[]; callTool(n: string, a?: unknown): Promise<unknown>; onNotification(m: string, cb: (x: unknown) => void): void };
  addEventListener(type: string, cb: (e: { data: unknown; source: unknown }) => void): void;
  removeEventListener(type: string, cb: (e: { data: unknown; source: unknown }) => void): void;
  deliver(data: unknown, source: unknown): void;
  postMessage(msg: { jsonrpc?: string; id?: number; method?: string; params?: unknown }): void;
};

function makeWindow(): Win {
  const listeners: Array<(e: { data: unknown; source: unknown }) => void> = [];
  return {
    parent: null,
    agentgemApp: undefined as never,
    addEventListener(type, cb) { if (type === "message") listeners.push(cb); },
    removeEventListener(_type, cb) { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); },
    deliver(data, source) { for (const cb of listeners.slice()) cb({ data, source }); },
    postMessage: undefined as never,
  };
}

function runShim(win: Win): void {
  const body = mcpAppClient().replace(/<\/?script>/g, "");
  // The shim references only `window`, resolved via this Function parameter (browser: the global).
  new Function("window", body)(win);
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
        if (initCount >= 2) child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", tools: [{ name: "agentgem_get_session_data" }] } }, parent);
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
    child.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { toolName: "agentgem_subscribe_sessions", chunk: { type: "event" } } }, parent);
    expect(chunks).toEqual([{ toolName: "agentgem_subscribe_sessions", chunk: { type: "event" } }]);
  });

  it("dispatches to a method-keyed subscriber the way the real scaffold/migrate callers do, filtering by toolName in the callback", async () => {
    // Mirrors scaffolds.ts:100 and migrate.ts's NEW_FEED_LISTENER verbatim: subscribe once on the
    // method, and let the callback itself decide which tool's chunk it cares about.
    const child = makeWindow();
    const parent = makeWindow();
    child.parent = parent;
    parent.postMessage = (msg) => {
      if (msg.method === "ui/initialize") child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", tools: [] } }, parent);
    };
    runShim(child);

    const received: Array<{ toolName: string; chunk: unknown }> = [];
    child.agentgemApp.onNotification("ui/notifications/tool-result", (p) => {
      const params = p as { toolName: string; chunk: unknown };
      if (params.toolName === "agentgem_get_session_data") received.push(params);
    });

    child.deliver(
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { toolName: "agentgem_get_session_data", chunk: { meta: {}, timeline: [] } } },
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
    expect(MCP_CLIENT_MARKER).toBe("agentgem:mcp-app-client");
    expect(mcpAppClient()).toContain(MCP_CLIENT_MARKER);
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
        if (msg.method === "ui/initialize") { deliverInit = () => child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", tools: [] } }, parent); return; }
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
        if (msg.method === "ui/initialize") { child.deliver({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "x", tools: [] } }, parent); return; }
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
