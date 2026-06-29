import { describe, it, expect } from "vitest";
import { renderCardSvg, cardDescription } from "./card.js";
// Parity: the console copy MUST byte-match the Worker-canonical copy.
import { renderCardSvg as workerSvg, cardDescription as workerDesc } from "../../../../../website/edge/src/card.js";

const cases = [
  { breadth: 14, battleTested: 3, portable: 5 },
  { breadth: 0, battleTested: 0, portable: 0 },
  { breadth: 1, battleTested: 1, portable: 1 },
];

describe("console card parity with the Worker", () => {
  for (const c of cases) {
    it(`renderCardSvg matches for ${JSON.stringify(c)}`, () => {
      expect(renderCardSvg(c)).toBe(workerSvg(c));
    });
    it(`cardDescription matches for ${JSON.stringify(c)}`, () => {
      expect(cardDescription(c)).toBe(workerDesc(c));
    });
  }
});
