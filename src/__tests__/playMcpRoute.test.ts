// src/__tests__/playMcpRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlayController } from "../play.controller.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "My Game", genre: "project-fun" as const, createdFrom: { kind: "project" as const, path: "/p", flavor: "node" }, engineVersion: "1" };
const html = "<!doctype html><body><canvas></canvas></body>";

describe("GET /api/play/mcp-app", () => {
  it("returns a spec-shaped resource + launcher tool for a saved miniapp", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "g1", html, meta } });
    const out = await ctrl.mcpApp({ query: { name: "g1" } });
    expect(out.resource.uri).toBe("ui://agentgem/g1");
    expect(out.resource.mimeType).toBe("text/html;profile=mcp-app");
    expect(out.resource.text).toBe(html);
    expect(out.resource._meta["ai.agentgem/game"].offline).toBe(true);
    expect(out.tool.name).toBe("play_g1");
    expect(out.tool._meta.ui.visibility).toEqual(["app"]);
  });

  it("404s for an unknown miniapp", async () => {
    const ctrl = new PlayController();
    await expect(ctrl.mcpApp({ query: { name: "nope" } })).rejects.toThrow();
  });

  // The built-in Protocol Inspector is a constant, never written to the registry — this must resolve
  // WITHOUT a prior save() (unlike every other case above) and without touching miniappsRoot() at all.
  it("synthesizes the inspector resource for name=__inspector without touching the registry", async () => {
    const ctrl = new PlayController();
    const out = await ctrl.mcpApp({ query: { name: "__inspector" } });
    expect(out.resource.uri).toBe("ui://agentgem/__inspector");
    expect(out.resource.mimeType).toBe("text/html;profile=mcp-app");
    expect(out.tool.name).toBe("play___inspector");
  });
});

describe("GET /api/play/inspector", () => {
  it("serves the constant inspector html + meta, never from disk", async () => {
    const ctrl = new PlayController();
    const out = await ctrl.inspector();
    expect(out.name).toBe("__inspector");
    expect(out.html).toContain("Protocol Inspector");
    expect(out.meta.needs).toEqual(expect.arrayContaining([
      "session-data", "local-project-access", "live-session-events", "invoke-agent",
      "open-link", "send-message", "update-model-context",
    ]));
  });
});
