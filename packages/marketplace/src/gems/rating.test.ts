import { describe, it, expect } from "vitest";
import { starCurve, stoneRating, adoptionCurve } from "./rating";

describe("starCurve", () => {
  it("maps star counts to 1..5 buckets", () => {
    expect([0,1,2,3,7,8,20,21,999].map(starCurve)).toEqual([1,2,2,3,3,4,4,5,5]);
  });
});
describe("adoptionCurve", () => {
  it("maps k-anon installs to 1..5 buckets (<5 → 1, ignored by max)", () => {
    expect([0,4,5,9,10,49,50,999].map(adoptionCurve)).toEqual([1,1,3,3,4,4,5,5]);
  });
});
describe("stoneRating", () => {
  it("takes the max of floor and star curve, clamped to 5", () => {
    expect(stoneRating(3, 0)).toBe(3);      // floor wins with no stars
    expect(stoneRating(1, 25)).toBe(5);     // stars win
    expect(stoneRating(undefined, 0)).toBe(1); // no floor → 1
    expect(stoneRating(3, 999)).toBe(5);    // clamp
  });
  it("blends adoption into the rating (3-arg)", () => {
    expect(stoneRating(1, 0, 50)).toBe(5);  // adoption wins
    expect(stoneRating(3, 0, 0)).toBe(3);   // floor wins (adoptionCurve(0)=1)
    expect(stoneRating(1, 0, 0)).toBe(1);   // nothing above floor 1
  });
  it("defaults installs to 0 so 2-arg still works", () => {
    expect(stoneRating(3, 0)).toBe(3);
  });
});
