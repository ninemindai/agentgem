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
  it("installs=50 raises rating to 5 even with grade=1 and 0 stars", () => {
    const { container } = render(<StoneRating cut="skill" grade={1} stars={0} installs={50} />);
    expect(container.querySelectorAll('[data-stone="filled"]').length).toBe(5);
  });
  it("renders the Diamond apex (data-diamond + 5 filled) when maxed on all axes", () => {
    const { container } = render(<StoneRating cut="skill" grade={3} stars={21} installs={50} verifiedInstalls={50} />);
    expect(container.querySelector('[data-diamond="true"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-stone="filled"]').length).toBe(5);
  });
  it("a 5-of-5 gem that is NOT diamond (maxed by one axis only) shows no diamond seal", () => {
    const { container } = render(<StoneRating cut="skill" grade={3} stars={21} installs={0} />);
    expect(container.querySelector('[data-diamond="true"]')).toBeNull(); // stars alone → 5 of 5, not Diamond
    expect(container.querySelectorAll('[data-stone="filled"]').length).toBe(5);
  });
  it("50 raw installs but 0 verified → 5 filled stones (raw drives count) but NOT diamond", () => {
    const { container } = render(<StoneRating cut="skill" grade={3} stars={21} installs={50} verifiedInstalls={0} />);
    expect(container.querySelector('[data-diamond="true"]')).toBeNull();
    expect(container.querySelectorAll('[data-stone="filled"]').length).toBe(5);
  });
  it("50 raw + 50 verified installs → diamond", () => {
    const { container } = render(<StoneRating cut="skill" grade={3} stars={21} installs={50} verifiedInstalls={50} />);
    expect(container.querySelector('[data-diamond="true"]')).toBeTruthy();
  });
});
