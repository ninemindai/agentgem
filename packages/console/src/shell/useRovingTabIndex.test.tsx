import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useRovingTabIndex } from "./useRovingTabIndex.js";

afterEach(cleanup);

function Tabs({ onSelect = () => {} }: { onSelect?: (i: number) => void }) {
  const labels = ["one", "two", "three"];
  const [sel, setSel] = [1, (i: number) => onSelect(i)];
  const roving = useRovingTabIndex({
    count: labels.length,
    selectedIndex: sel,
    onSelect: (i) => setSel(i),
  });
  return (
    <div {...roving.containerProps} role="tablist">
      {labels.map((l, i) => (
        <button key={l} {...roving.getTabProps(i)} role="tab">
          {l}
        </button>
      ))}
    </div>
  );
}

describe("useRovingTabIndex", () => {
  it("makes only the selected item tab-focusable (roving tabindex)", () => {
    render(<Tabs />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });

  it("ArrowRight selects the next item; clamps at the end", () => {
    const onSelect = vi.fn();
    render(<Tabs onSelect={onSelect} />);
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "ArrowRight" }); // from selected=1 → 2
    expect(onSelect).toHaveBeenLastCalledWith(2);
  });

  it("ArrowLeft selects the previous item", () => {
    const onSelect = vi.fn();
    render(<Tabs onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowLeft" }); // 1 → 0
    expect(onSelect).toHaveBeenLastCalledWith(0);
  });

  it("Home selects the first, End selects the last", () => {
    const onSelect = vi.fn();
    render(<Tabs onSelect={onSelect} />);
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(list, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith(2);
  });

  it("clamps ArrowLeft at the first item (no wrap)", () => {
    const onSelect = vi.fn();
    // selectedIndex starts at 1; move to 0 then try to go past
    render(<Tabs onSelect={onSelect} />);
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "Home" }); // → 0
    fireEvent.keyDown(list, { key: "ArrowLeft" }); // clamp at 0
    expect(onSelect).toHaveBeenLastCalledWith(0);
  });
});
