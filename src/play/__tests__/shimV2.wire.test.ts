import { describe, it, expect } from "vitest";
import { mcpAppClient } from "@agentgem/play";

// This file used to duplicate coverage that now lives, more strongly, as behavioral assertions in
// mcpAppClient.test.ts (ui/initialize round-trip, _meta["ai.agentgem/host"].tools, the tool-result
// CallToolResult unwrap, ui/resource-teardown reply) and mcpApp.test.ts / mcpApp.conformance.test.ts
// (the launcher inputSchema.properties.view shape). Those static substring checks and the duplicate
// launcher-schema assertion were deleted. The one thing they proved that the behavioral test does not
// — the exact literal MCP Apps protocolVersion string sent on the wire — is kept below.
describe("shim v2 wire", () => {
  it("pins the literal MCP Apps protocolVersion sent in the ui/initialize request", () => {
    expect(mcpAppClient()).toMatch(/protocolVersion\s*:\s*"2026-01-26"/);
  });
});
