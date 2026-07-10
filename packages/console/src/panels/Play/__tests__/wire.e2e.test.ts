// packages/console/src/panels/Play/__tests__/wire.e2e.test.ts
// Host-side half of the host/shim wire-agreement guard: drives the real `createUiHost` router
// directly (no shim involved) to pin the `ui/initialize` reply shape (hostInfo/hostCapabilities/no
// top-level tools/_meta['ai.agentgem/host'].tools).
//
// The shim-side half (evaluating the actual emitted shim source in a real jsdom window and proving it
// agrees with the host on `_meta` shapes for tool-result unwrapping + resource-teardown) has moved to
// the CI-gated root test src/play/__tests__/wireShim.test.ts — it depends only on @agentgem/play's
// `mcpAppClient` + jsdom, not on this package's `createUiHost`, and packages/console tests are not
// collected by root `pnpm test`.
import { describe, it, expect } from "vitest";
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
