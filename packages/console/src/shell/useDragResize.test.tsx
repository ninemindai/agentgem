import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { applyDrag, useDragResize } from "./useDragResize.js";

afterEach(cleanup);

describe("applyDrag (pure)", () => {
  it("adds delta and clamps to [min,max]", () => {
    expect(applyDrag(200, 50, { min: 100, max: 300 })).toBe(250);
    expect(applyDrag(200, 500, { min: 100, max: 300 })).toBe(300);
    expect(applyDrag(200, -500, { min: 100, max: 300 })).toBe(100);
  });
  it("inverts delta for end-side handles", () => {
    expect(applyDrag(200, 50, { min: 100, max: 300, invert: true })).toBe(150);
  });
});

function Harness({ onChange }: { onChange: (n: number) => void }) {
  const { handleProps } = useDragResize({ value: 200, min: 100, max: 300, onChange, step: 16 });
  return <div data-testid="h" {...handleProps} />;
}

describe("useDragResize keyboard", () => {
  it("nudges by step on Arrow keys and jumps on Home/End", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const h = screen.getByTestId("h");
    fireEvent.keyDown(h, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(216);
    fireEvent.keyDown(h, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(184);
    fireEvent.keyDown(h, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(300);
    fireEvent.keyDown(h, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(100);
  });
  it("exposes separator a11y props", () => {
    render(<Harness onChange={() => {}} />);
    const h = screen.getByTestId("h");
    expect(h.getAttribute("role")).toBe("separator");
    expect(h.getAttribute("aria-valuenow")).toBe("200");
    expect(h.getAttribute("aria-valuemin")).toBe("100");
    expect(h.getAttribute("aria-valuemax")).toBe("300");
  });
});
