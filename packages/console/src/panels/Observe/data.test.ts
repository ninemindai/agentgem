import { describe, it, expect } from "vitest";
import { fmtTokens, fmtDuration, tokenSeries } from "./data.js";

describe("formatters", () => {
  it("fmtTokens scales", () => {
    expect(fmtTokens(300)).toBe("300");
    expect(fmtTokens(950_00)).toBe("95k");
    expect(fmtTokens(1_200_000)).toBe("1.2M");
  });
  it("fmtDuration scales", () => {
    expect(fmtDuration(30_000)).toBe("30s");
    expect(fmtDuration(47 * 60_000)).toBe("47m");
    expect(fmtDuration(Math.round(2.1 * 3_600_000))).toBe("2.1h");
  });
  it("tokenSeries maps daily points to short keys", () => {
    expect(tokenSeries([{ date: "2026-06-28", sessions: 1, msgs: 4, tokensIn: 100, tokensOut: 40, tokensCache: 10 }]))
      .toEqual([{ date: "2026-06-28", in: 100, out: 40, cache: 10 }]);
  });
});
