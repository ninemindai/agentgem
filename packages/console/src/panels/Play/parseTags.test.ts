import { describe, it, expect } from "vitest";
import { parseTags } from "./parseTags.js";

describe("parseTags", () => {
  it("splits on commas, trims, lowercases", () => {
    expect(parseTags("Puzzle, CO-OP , Roguelike")).toEqual(["puzzle", "co-op", "roguelike"]);
  });
  it("drops empties and whitespace-only entries", () => {
    expect(parseTags("puzzle,, ,coop")).toEqual(["puzzle", "coop"]);
  });
  it("drops reserved words (game + the 4 genres)", () => {
    expect(parseTags("game, replay, project-fun, puzzle, session-heatmap, skill-run")).toEqual(["puzzle"]);
  });
  it("dedupes case-insensitively", () => {
    expect(parseTags("puzzle, Puzzle, PUZZLE")).toEqual(["puzzle"]);
  });
  it("drops tags longer than 24 chars", () => {
    expect(parseTags("ok, thisisaveryverylongtagover24chars")).toEqual(["ok"]);
  });
  it("caps at 8 tags", () => {
    expect(parseTags("a,b,c,d,e,f,g,h,i,j")).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });
  it("returns [] for blank input", () => {
    expect(parseTags("   ")).toEqual([]);
  });
});
