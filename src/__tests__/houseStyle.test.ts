// src/__tests__/houseStyle.test.ts
import { describe, it, expect } from "vitest";
import { HOUSE_TOKENS, HOUSE_TOKEN_NAMES, HOUSE_PARTIALS, themeAdapter } from "@agentgem/model";

const MODES = ["host", "document", "fixed"] as const;

describe("houseStyle", () => {
  it("every theme mode binds every shared colour token", () => {
    for (const mode of MODES) {
      const css = themeAdapter(mode);
      for (const name of HOUSE_TOKEN_NAMES) {
        expect(`${mode}:${name}:${css.includes(`${name}:`)}`).toBe(`${mode}:${name}:true`);
      }
    }
  });

  it("the host adapter resolves through host variables with literal fallbacks", () => {
    const css = themeAdapter("host");
    expect(css).toContain("var(--color-text-primary,");
    expect(css).toContain("var(--color-background-primary,");
    expect(css).toContain("var(--color-border-primary,");
  });

  it("the fixed adapter uses no CSS variables (dashboard has no host)", () => {
    expect(themeAdapter("fixed")).not.toContain("var(--color-");
  });

  it("invariant tokens carry the type stack and scale", () => {
    expect(HOUSE_TOKENS).toContain("--serif:");
    expect(HOUSE_TOKENS).toContain("--mono:");
    expect(HOUSE_TOKENS).toContain("--t-display:");
  });

  it("partials are non-empty CSS and emit no markup", () => {
    for (const css of Object.values(HOUSE_PARTIALS)) {
      expect(css.length).toBeGreaterThan(0);
      expect(css).not.toContain("<");
    }
  });
});
