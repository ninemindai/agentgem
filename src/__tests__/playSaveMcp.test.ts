// src/__tests__/playSaveMcp.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlayController } from "../play.controller.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "Pulse", genre: "project-fun" as const, createdFrom: { kind: "blank" as const, title: "Pulse" }, engineVersion: "1" };

describe("POST /api/play/save with mcpNeeds", () => {
  it("persists the declared manifest and reports scan warnings through the route", async () => {
    const ctrl = new PlayController();
    // Guarded like Task 4's mcpHtml fixtures (miniappsMcp.test.ts): gameGate's jsdom load-smoke has no
    // client shim, so `window.agentgemApp.mcp` is undefined there and the guard keeps the body — including
    // the never-invoked `c("github", pick())` call — from executing at gate time. The non-literal
    // `callTool(s, t)` text is still present for capabilityScan's static regex to flag as a warning.
    const html = `<!doctype html><body><canvas></canvas><script>if (window.agentgemApp && window.agentgemApp.mcp) { const c = (s, t) => window.agentgemApp.mcp.callTool(s, t); c("github", pick()); }</script></body>`;
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
