// src/gem/__tests__/gemGrade.test.ts
import { describe, it, expect } from "vitest";
import { scorecardFloor, GEM_GRADE_MIN, GEM_GRADE_MAX } from "@agentgem/model";

describe("scorecardFloor", () => {
  it("floors at 1 with no battle-tested/portable workflows", () => {
    expect(scorecardFloor({ breadth: 4, battleTested: 0, portable: 0 })).toBe(1);
  });
  it("rises to 2 with at least one battle-tested workflow", () => {
    expect(scorecardFloor({ breadth: 1, battleTested: 1, portable: 0 })).toBe(2);
  });
  it("rises to 3 when also portable, and clamps there", () => {
    expect(scorecardFloor({ breadth: 9, battleTested: 5, portable: 3 })).toBe(3);
  });
  it("exposes the 1..3 bounds", () => {
    expect([GEM_GRADE_MIN, GEM_GRADE_MAX]).toEqual([1, 3]);
  });
});
