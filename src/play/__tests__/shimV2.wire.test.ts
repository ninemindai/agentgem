import { describe, it, expect } from "vitest";
import { mcpAppClient, mcpAppFor } from "@agentgem/play";

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

describe("launcher tool input schema", () => {
  it("launcher tool declares an input schema (not empty)", () => {
    const app = mcpAppFor({ name: "g", html: "<html></html>", meta: { title: "T", genre: "replay", createdFrom: { kind: "blank", title: "T" }, engineVersion: "2" } as any });
    expect(app.tool.inputSchema.type).toBe("object");
    // A minimal but present property, so a host has something to stream as tool-input.
    expect(app.tool.inputSchema.properties).toHaveProperty("view");
  });
});
