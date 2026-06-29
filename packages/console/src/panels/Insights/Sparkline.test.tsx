import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Sparkline } from "./Sparkline.js";

afterEach(cleanup);

describe("Sparkline", () => {
  it("renders an empty hint when there is no data", () => {
    const { container } = render(<Sparkline values={[]} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toMatch(/no data/i);
  });
  it("draws a producers polyline and, when given verified, a second overlay", () => {
    const { container } = render(<Sparkline values={[1, 3, 7]} verified={[0, 1, 4]} />);
    expect(container.querySelectorAll("polyline").length).toBe(2);
  });
  it("draws a single producers polyline when no verified series", () => {
    const { container } = render(<Sparkline values={[2, 4]} />);
    expect(container.querySelectorAll("polyline").length).toBe(1);
  });
});
