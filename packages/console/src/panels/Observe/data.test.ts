import { describe, it, expect } from "vitest";
import { fmtTokens, fmtDuration, tokenSeries, fmtTime, flameLevel, heatmapCells, utcDay } from "./data.js";

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

describe("fmtTime", () => {
  it("returns a non-empty string for any timestamp", () => {
    const result = fmtTime(1_000_000_000_000);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("flameLevel", () => {
  it("returns 0 when maxTokens is 0", () => {
    expect(flameLevel(1000, 0)).toBe(0);
  });
  it("returns 3 when ratio >= 0.75", () => {
    expect(flameLevel(750, 1000)).toBe(3);
    expect(flameLevel(1000, 1000)).toBe(3);
  });
  it("returns 2 when ratio is 0.4-0.74", () => {
    expect(flameLevel(400, 1000)).toBe(2);
    expect(flameLevel(500, 1000)).toBe(2);
  });
  it("returns 1 when ratio is 0.15-0.39", () => {
    expect(flameLevel(200, 1000)).toBe(1);
    expect(flameLevel(150, 1000)).toBe(1);
  });
  it("returns 0 when ratio < 0.15", () => {
    expect(flameLevel(100, 1000)).toBe(0);
    expect(flameLevel(0, 1000)).toBe(0);
  });
});

describe("heatmapCells", () => {
  it("returns [] for empty input", () => {
    expect(heatmapCells([])).toEqual([]);
  });

  it("assigns correct weekday and week indices across a week boundary", () => {
    // 2026-06-27 = Saturday (UTC day 6), 2026-06-28 = Sunday (UTC day 0), 2026-06-29 = Monday (UTC day 1)
    const daily = [
      { date: "2026-06-27", sessions: 1, msgs: 2, tokensIn: 100, tokensOut: 50, tokensCache: 10 },
      { date: "2026-06-28", sessions: 5, msgs: 20, tokensIn: 500, tokensOut: 200, tokensCache: 50 },
      { date: "2026-06-29", sessions: 2, msgs: 8, tokensIn: 200, tokensOut: 80, tokensCache: 20 },
    ];
    const cells = heatmapCells(daily);
    expect(cells).toHaveLength(3);

    const sat = cells.find(c => c.date === "2026-06-27")!;
    const sun = cells.find(c => c.date === "2026-06-28")!;
    const mon = cells.find(c => c.date === "2026-06-29")!;

    expect(sat.weekday).toBe(6); // Saturday
    expect(sun.weekday).toBe(0); // Sunday — starts new week column
    expect(mon.weekday).toBe(1); // Monday

    // Sunday starts week 1 (first sunday in range is the Sunday itself)
    expect(sat.week).toBe(0);
    expect(sun.week).toBe(1);
    expect(mon.week).toBe(1);

    // sessions=5 is the max → level 4
    expect(sun.level).toBe(4);
  });

  it("computes tokens as sum of in+out+cache", () => {
    const daily = [{ date: "2026-06-28", sessions: 3, msgs: 10, tokensIn: 100, tokensOut: 50, tokensCache: 25 }];
    const cells = heatmapCells(daily);
    expect(cells[0].tokens).toBe(175);
  });

  it("assigns level 0 for sessions=0", () => {
    const daily = [{ date: "2026-06-28", sessions: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 }];
    const cells = heatmapCells(daily);
    expect(cells[0].level).toBe(0);
  });

  it("default (no metric arg) uses tokens", () => {
    // day A: low sessions (1), high tokens (900k). day B: high sessions (5), low tokens (50k).
    // token-max → day A level=4; session-max → day B level=4.
    const daily = [
      { date: "2026-06-27", sessions: 1, msgs: 2, tokensIn: 600_000, tokensOut: 200_000, tokensCache: 100_000 },
      { date: "2026-06-28", sessions: 5, msgs: 20, tokensIn: 30_000, tokensOut: 15_000, tokensCache: 5_000 },
    ];
    const cells = heatmapCells(daily); // default = "tokens"
    const dayA = cells.find(c => c.date === "2026-06-27")!;
    const dayB = cells.find(c => c.date === "2026-06-28")!;
    expect(dayA.level).toBe(4); // 900k / 900k = 1.0 → level 4
    expect(dayB.level).toBeLessThan(4); // 50k / 900k ≈ 0.055 → level 1
  });

  it("metric=tokens levels track token totals", () => {
    const daily = [
      { date: "2026-06-27", sessions: 1, msgs: 2, tokensIn: 600_000, tokensOut: 200_000, tokensCache: 100_000 },
      { date: "2026-06-28", sessions: 5, msgs: 20, tokensIn: 30_000, tokensOut: 15_000, tokensCache: 5_000 },
    ];
    const cells = heatmapCells(daily, "tokens");
    const dayA = cells.find(c => c.date === "2026-06-27")!;
    expect(dayA.level).toBe(4);
  });

  it("metric=sessions levels track session counts", () => {
    const daily = [
      { date: "2026-06-27", sessions: 1, msgs: 2, tokensIn: 600_000, tokensOut: 200_000, tokensCache: 100_000 },
      { date: "2026-06-28", sessions: 5, msgs: 20, tokensIn: 30_000, tokensOut: 15_000, tokensCache: 5_000 },
    ];
    const cells = heatmapCells(daily, "sessions");
    const dayA = cells.find(c => c.date === "2026-06-27")!;
    const dayB = cells.find(c => c.date === "2026-06-28")!;
    expect(dayB.level).toBe(4); // 5/5 = 1.0 → level 4
    expect(dayA.level).toBeLessThan(4); // 1/5 = 0.2 → level 1
  });
});

describe("utcDay", () => {
  it("returns YYYY-MM-DD in UTC regardless of local timezone", () => {
    // 2026-06-28T00:00:00.000Z → "2026-06-28"
    const ms = Date.parse("2026-06-28T00:00:00.000Z");
    expect(utcDay(ms)).toBe("2026-06-28");
  });

  it("uses UTC not local date", () => {
    // Parse an ISO string to get the exact UTC ms, then verify utcDay round-trips it.
    const ms = Date.parse("2026-06-28T00:00:00.000Z");
    const result = utcDay(ms);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).toBe("2026-06-28");
  });
});
