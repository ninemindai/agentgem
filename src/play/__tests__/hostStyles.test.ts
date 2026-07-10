import { describe, it, expect } from "vitest";
import { hostStyleScript, MCP_UI_STYLE_KEYS } from "@agentgem/play";

describe("hostStyles", () => {
  it("emits applyDocumentTheme and applyHostStyleVariables", () => {
    const s = hostStyleScript();
    expect(s).toContain("function applyDocumentTheme");
    expect(s).toContain("function applyHostStyleVariables");
    expect(s).toContain("data-theme");
    expect(s).toContain("color-scheme");
  });
  it("lists the standardized color keys the console maps", () => {
    expect(MCP_UI_STYLE_KEYS).toContain("--color-background-primary");
    expect(MCP_UI_STYLE_KEYS).toContain("--color-text-primary");
  });
  it("does NOT emit applyHostFonts (sealed CSP forbids @font-face URLs)", () => {
    expect(hostStyleScript()).not.toContain("applyHostFonts");
  });
});
