// src/__tests__/playSaveMcp.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlayController } from "@agentgem/app/play.controller";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "Pulse", genre: "project-fun" as const, createdFrom: { kind: "blank" as const, title: "Pulse" }, engineVersion: "1" };

describe("POST /api/play/save with mcpNeeds", () => {
  it("persists the declared manifest and reports scan warnings through the route", async () => {
    const ctrl = new PlayController();
    // PR-3a's shim arm makes `window.agentgemApp.mcp` unconditional (mcpAppClient.ts), so this guard
    // now DOES execute at gate time — sendRequest() just queues an unresolved promise in jsdom (no
    // host to reply), it never throws. `pick()` has to be a real function so the call doesn't
    // ReferenceError; it still passes a non-literal (computed) tool name, which is all
    // capabilityScan's static regex needs to flag the "non-literal" warning below.
    const html = `<!doctype html><body><canvas></canvas><script>function pick() { return "list_pull_requests"; } if (window.agentgemApp && window.agentgemApp.mcp) { const c = (s, t) => window.agentgemApp.mcp.callTool(s, t); c("github", pick()); }</script></body>`;
    const declared = [{ server: "github", tools: ["list_pull_requests"] }];
    const saved = await ctrl.save({ body: { name: "pulse", html, meta: { ...meta, mcpNeeds: declared } } });
    expect(saved.mcpWarnings).toHaveLength(1);
    const read = await ctrl.miniapp({ query: { name: "pulse" } });
    expect(read.meta.mcpNeeds).toEqual(declared);
  });

  it("stays absent end-to-end for a plain miniapp (regression)", async () => {
    const ctrl = new PlayController();
    const saved = await ctrl.save({ body: { name: "plain", html: "<!doctype html><body><canvas></canvas></body>", meta } });
    expect(saved.mcpWarnings).toEqual([]);
    const read = await ctrl.miniapp({ query: { name: "plain" } });
    expect(read.meta.mcpNeeds).toBeUndefined();
  });
});
