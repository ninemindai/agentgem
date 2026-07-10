// src/play/__tests__/wireShim.test.ts
// The shim half of the host/shim wire-agreement guard split out of packages/console's
// wire.e2e.test.ts (see that file's remaining "host ui/initialize reply shape" describe for the
// other half). This half depends only on @agentgem/play's `mcpAppClient` (a plain string-producing
// function with zero DOM dependency) + jsdom, so it belongs in the CI-gated root test home rather
// than packages/console (which is never collected by root `pnpm test`).
//
// Evaluates the ACTUAL shim source (built by @agentgem/play) inside a real jsdom window via
// `runScripts: "dangerously"` — the same technique @agentgem/play's own gameGate.ts uses to
// load-smoke generated games — and drives it with host-shaped messages, asserting the shim's
// `onNotification` callback receives exactly the frozen `{toolName, chunk}` shape games consume, and
// that it answers a `ui/resource-teardown` request. This is the guard against a host/shim
// dispatch-mismatch: if either side's `_meta` key or field name drifts, this test fails.
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { mcpAppClient } from "@agentgem/play";

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

    // Exactly the shape mcpUiHost.ts's notify() posts (see packages/console's mcpUiHost.ts's `notify`).
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
