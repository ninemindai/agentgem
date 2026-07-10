// src/play/__tests__/inspector.gate.test.ts
import { describe, it, expect } from "vitest";
import { INSPECTOR_HTML, INSPECTOR_META, gameGate, deriveNeeds, mcpAppFor } from "@agentgem/play";

describe("protocol inspector", () => {
  it("passes the seal", async () => {
    const r = await gameGate(INSPECTOR_HTML);
    expect(r.ok, r.failures.join("; ")).toBe(true);
  });

  it("exercises every capability (derives all seven)", () => {
    const needs = deriveNeeds(INSPECTOR_HTML);
    expect(needs).toEqual(expect.arrayContaining([
      "session-data", "local-project-access", "live-session-events", "invoke-agent",
      "open-link", "send-message", "update-model-context",
    ]));
  });

  it("mints as an MCP Apps resource", () => {
    const app = mcpAppFor({ name: INSPECTOR_META.name, html: INSPECTOR_HTML, meta: INSPECTOR_META });
    expect(app.resource.uri).toBe("ui://agentgem/__inspector");
  });
});
