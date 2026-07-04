import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { RatingInput } from "./RatingInput";

afterEach(() => cleanup());

function Harness({ onChange }: { onChange?: (n: number) => void }) {
  const [v, setV] = useState(0);
  return <RatingInput value={v} onChange={(n) => { setV(n); onChange?.(n); }} />;
}

describe("RatingInput", () => {
  it("is a radiogroup of five radios", () => {
    render(<Harness />);
    expect(screen.getByRole("radiogroup", { name: "Your rating" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(5);
  });

  it("click sets the value (aria-checked reflects it)", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "4 stars" }));
    expect(onChange).toHaveBeenCalledWith(4);
    expect(screen.getByRole("radio", { name: "4 stars" }).getAttribute("aria-checked")).toBe("true");
  });

  it("number keys and arrows set the value", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const first = screen.getByRole("radio", { name: "1 star" });
    fireEvent.keyDown(first, { key: "5" });
    expect(onChange).toHaveBeenLastCalledWith(5);
    fireEvent.keyDown(screen.getByRole("radio", { name: "5 stars" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(4);
  });
});
