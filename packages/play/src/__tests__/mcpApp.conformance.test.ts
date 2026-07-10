import { describe, it, expect } from "vitest";
import { mcpAppClient } from "../mcpAppClient.js";

describe("shim v2 wire", () => {
  const src = mcpAppClient();
  it("sends ui/initialize with appInfo + appCapabilities + protocolVersion", () => {
    expect(src).toContain('method: "ui/initialize"');
    expect(src).toMatch(/appInfo\s*:/);
    expect(src).toMatch(/appCapabilities\s*:/);
    expect(src).toMatch(/protocolVersion\s*:\s*"2026-01-26"/);
  });
  it("unwraps tool-result _meta stream identity into {toolName, chunk}", () => {
    expect(src).toContain("ai.agentgem/stream");
    expect(src).toContain("structuredContent");
  });
  it("does not read a top-level `tools` off the initialize result", () => {
    // v2 reads granted tools from _meta['ai.agentgem/host'], not result.tools.
    expect(src).toContain("ai.agentgem/host");
  });
});
