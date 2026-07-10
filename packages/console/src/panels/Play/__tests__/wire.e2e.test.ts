// packages/console/src/panels/Play/__tests__/wire.e2e.test.ts
// End-to-end proof that the host router (mcpUiHost.ts) and the embedded client shim
// (@agentgem/play's mcpAppClient) AGREE on the wire's `_meta` shapes — not just that each side's own
// unit tests pass in isolation. Two prior test files each assert one half of the contract by inspecting
// literal object shapes (mcpUiHost.test.ts) or by substring-scanning the emitted script source
// (mcpApp.conformance.test.ts); neither actually runs the shim's code and feeds it a message shaped the
// way the host really posts it. This file closes that gap:
//   1. drives the real `createUiHost` router directly (no shim involved) to pin the `ui/initialize`
//      reply shape (hostInfo/hostCapabilities/no top-level tools/_meta['ai.agentgem/host'].tools).
//   2. evaluates the ACTUAL shim source (built by packages/play) inside a real jsdom window via
//      `runScripts: "dangerously"` — the same technique @agentgem/play's own gameGate.ts uses to
//      load-smoke generated games — and drives it with a host-shaped notify message, asserting the
//      shim's `onNotification` callback receives exactly the frozen `{toolName, chunk}` shape games
//      consume. This is the guard against a host/shim dispatch-mismatch: if either side's `_meta` key
//      or field name drifts, this test (not just each side's own substring checks) fails.
//   3. same jsdom-eval'd shim, proving it answers a `ui/resource-teardown` REQUEST (not just a
//      notification) with the required JSON-RPC result.
//
// Placement: console, not play. @agentgem/play's `mcpAppClient` is exported as a plain string-producing
// function with zero DOM dependency, and `jsdom` (with `runScripts: "dangerously"`) is already a
// devDependency of packages/console (independent of the ambient vitest `environment: "jsdom"`, which
// does NOT execute inline scripts — this file spins up its own `JSDOM` instance instead, exactly like
// packages/play/src/gameGate.ts does for generated games). Keeping the round-trip here also means the
// HOST half (createUiHost, part 1) and the SHIM half (part 2/3) live in one file next to mcpUiHost.ts,
// where a future change to either side's `_meta` key is most likely to be reviewed.
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { mcpAppClient } from "@agentgem/play";
import { createUiHost, type UiHostDeps } from "../mcpUiHost.js";

describe("wire.e2e — host ui/initialize reply shape", () => {
  it("is spec-shaped: hostInfo + hostCapabilities present, no top-level tools, tools under _meta", () => {
    const posted: unknown[] = [];
    const target = { postMessage: (m: unknown) => posted.push(m) } as unknown as Window;
    const deps: UiHostDeps = {
      apiBase: "", name: "g", needs: ["session-data"], interactive: true, target,
      requestConsent: async () => true,
    };
    const host = createUiHost(deps);
    host.handleMessage({ source: target, data: { jsonrpc: "2.0", id: 1, method: "ui/initialize" } } as unknown as MessageEvent);

    const reply = posted[0] as { result: Record<string, unknown> };
    const result = reply.result;
    expect(result).toHaveProperty("hostInfo");
    expect(result).toHaveProperty("hostCapabilities");
    expect(result).not.toHaveProperty("tools");
    const meta = result._meta as { "ai.agentgem/host": { tools: unknown[] } };
    expect(Array.isArray(meta["ai.agentgem/host"].tools)).toBe(true);
    expect(meta["ai.agentgem/host"].tools.length).toBeGreaterThan(0);
  });
});

// Evaluate the real emitted shim in a fresh jsdom window (NOT the ambient vitest jsdom environment,
// which never executes scripts). `window.parent` is patched in `beforeParse`, before the shim's IIFE
// runs and captures `host = window.parent`, so the shim's `e.source !== host` boundary check sees our
// fake parent as the trusted host frame.
function loadShim() {
  const posted: unknown[] = [];
  let fakeParent!: { postMessage: (msg: unknown) => void };
  const dom = new JSDOM(`<!doctype html><html><body>${mcpAppClient()}</body></html>`, {
    runScripts: "dangerously",
    beforeParse(window) {
      fakeParent = { postMessage: (msg: unknown) => { posted.push(msg); } };
      Object.defineProperty(window, "parent", { value: fakeParent, configurable: true });
    },
  });
  const fromHost = (data: unknown) => {
    const ev = new dom.window.MessageEvent("message", { data });
    Object.defineProperty(ev, "source", { value: fakeParent }); // jsdom's MessageEvent ctor drops `source`
    dom.window.dispatchEvent(ev);
  };
  return { window: dom.window, posted, fromHost };
}

describe("wire.e2e — shim/host agreement (real shim, real host-shaped messages)", () => {
  it("unwraps a host notify()-shaped CallToolResult into the frozen {toolName, chunk}", async () => {
    const { window, fromHost } = loadShim();
    await new Promise((r) => setTimeout(r, 0)); // let the shim's IIFE run and attach its listener

    const received: unknown[] = [];
    (window as unknown as { agentgemApp: { onNotification(m: string, cb: (e: unknown) => void): void } })
      .agentgemApp.onNotification("ui/notifications/tool-result", (evt) => received.push(evt));

    // Exactly the shape mcpUiHost.ts's notify() posts (see mcpUiHost.ts's `notify`).
    fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { content: [], structuredContent: { k: 1 }, _meta: { "ai.agentgem/stream": { toolName: "agentgem_get_session_data" } } },
    });

    expect(received).toEqual([{ toolName: "agentgem_get_session_data", chunk: { k: 1 } }]);
  });

  it("answers a ui/resource-teardown request with the JSON-RPC result the host expects", async () => {
    const { posted, fromHost } = loadShim();
    await new Promise((r) => setTimeout(r, 0));
    posted.length = 0; // drop the initial ui/initialize the shim posts on load

    fromHost({ jsonrpc: "2.0", id: 9, method: "ui/resource-teardown" });

    expect(posted).toContainEqual({ jsonrpc: "2.0", id: 9, result: {} });
  });
});
