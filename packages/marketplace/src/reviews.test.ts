import { describe, it, expect } from "vitest";
import { ratingStars } from "./reviews";

describe("ratingStars", () => {
  it("renders a normal rating", () => {
    expect(ratingStars(3)).toBe("★★★☆☆");
    expect(ratingStars(5)).toBe("★★★★★");
    expect(ratingStars(0)).toBe("☆☆☆☆☆");
  });

  it("clamps an out-of-range rating instead of throwing RangeError", () => {
    expect(() => ratingStars(7)).not.toThrow();
    expect(ratingStars(7)).toBe("★★★★★");
    expect(() => ratingStars(-1)).not.toThrow();
    expect(ratingStars(-1)).toBe("☆☆☆☆☆");
  });

  it("coerces NaN to zero stars", () => {
    expect(ratingStars(NaN)).toBe("☆☆☆☆☆");
  });

  it("rounds a fractional rating", () => {
    expect(ratingStars(2.6)).toBe("★★★☆☆");
  });
});
