// src/play/__tests__/repoPulse.gate.test.ts
import { describe, it, expect } from "vitest";
import {
  REPO_PULSE_HTML, REPO_PULSE_META, gameGate, deriveNeeds, deriveMcpNeeds, mcpAppFor,
} from "@agentgem/play";

describe("repo pulse", () => {
  it("passes the seal", async () => {
    const r = await gameGate(REPO_PULSE_HTML);
    expect(r.ok, r.failures.join("; ")).toBe(true);
  });

  it("derives no classic capabilities (connector-only miniapp)", () => {
    expect(deriveNeeds(REPO_PULSE_HTML)).toEqual([]);
  });

  // The scanner only sees the full literal form window.agentgemApp.mcp.callTool("s", "t") and returns
  // tools deduped + sorted — the demo's call sites are written that way on purpose, so the derived
  // manifest must reproduce the declaration exactly. If this drifts, a call site got aliased.
  it("derived mcp usage matches the declared manifest exactly", () => {
    expect(deriveMcpNeeds(REPO_PULSE_HTML)).toEqual(REPO_PULSE_META.mcpNeeds);
  });

  it("declares the three read tools on the github server (sorted)", () => {
    expect(REPO_PULSE_META.mcpNeeds).toEqual([
      { server: "github", tools: ["list_commits", "list_pull_requests", "search_pull_requests"] },
    ]);
  });

  it("mints as an MCP Apps resource", () => {
    const app = mcpAppFor({ name: REPO_PULSE_META.name, html: REPO_PULSE_HTML, meta: REPO_PULSE_META });
    expect(app.resource.uri).toBe("ui://agentgem/__repo-pulse");
  });

  it("renders a no-connector fallback state (marketplace parity)", () => {
    expect(REPO_PULSE_HTML).toContain("no-connector");
  });
});
