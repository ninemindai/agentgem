import { describe, it, expect } from "vitest";
import { renderCardSvg, cardDescription } from "./card.js";

const counts = { breadth: 14, battleTested: 3, portable: 5 };

describe("renderCardSvg", () => {
  it("is a 1200x630 svg containing the verbatim counts and copy", () => {
    const svg = renderCardSvg(counts);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
    expect(svg).toContain("My Agent Goldmine");
    expect(svg).toContain("14 reusable workflows");
    expect(svg).toContain("3 battle-tested");
    expect(svg).toContain("5 worth sharing");
    expect(svg).toContain("Valued with AgentGem");
    expect(svg).toContain("AgentGem");
  });

  it("escapes nothing dangerous (counts are numbers) and coerces to integers", () => {
    const svg = renderCardSvg({ breadth: 0, battleTested: 0, portable: 0 });
    expect(svg).toContain("0 reusable workflows");
  });
});

describe("cardDescription", () => {
  it("is the verbatim one-line summary", () => {
    expect(cardDescription(counts)).toBe(
      "14 reusable workflows · 3 battle-tested · 5 worth sharing — valued with AgentGem",
    );
  });
});
