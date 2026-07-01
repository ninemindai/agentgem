import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { StoneRating } from "./StoneRating";

afterEach(() => cleanup());
describe("StoneRating", () => {
  it("renders 5 gemstones with N filled", () => {
    const { container } = render(<StoneRating cut="skill" grade={3} stars={0} />);
    expect(container.querySelectorAll("[data-stone]").length).toBe(5);
    expect(container.querySelectorAll('[data-stone="filled"]').length).toBe(3);
  });
  it("unknown cut still renders (neutral), grade undefined + 0 stars → 1 filled", () => {
    const { container } = render(<StoneRating cut={undefined} grade={undefined} stars={0} />);
    expect(container.querySelectorAll('[data-stone="filled"]').length).toBe(1);
  });
});
