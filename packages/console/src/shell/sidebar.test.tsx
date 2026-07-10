import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { resolveWidth, isRail, loadRail, saveRail, RAIL_W, FULL_MIN, FULL_MAX, useSidebar } from "./sidebar.js";

afterEach(() => { cleanup(); localStorage.clear(); });

describe("resolveWidth", () => {
  it("snaps below threshold to the rail width", () => {
    expect(resolveWidth(0)).toBe(RAIL_W);
    expect(resolveWidth(129)).toBe(RAIL_W);
  });
  it("clamps full mode to [FULL_MIN, FULL_MAX]", () => {
    expect(resolveWidth(130)).toBe(FULL_MIN); // dead zone rounds up to min
    expect(resolveWidth(244)).toBe(244);
    expect(resolveWidth(9999)).toBe(FULL_MAX);
  });
});

describe("isRail", () => {
  it("is true only at the rail width", () => {
    expect(isRail(RAIL_W)).toBe(true);
    expect(isRail(FULL_MIN)).toBe(false);
  });
});

describe("loadRail/saveRail", () => {
  it("round-trips and defaults on garbage", () => {
    saveRail({ width: 300, collapsed: true });
    expect(loadRail()).toEqual({ width: 300, collapsed: true });
    localStorage.setItem("agentgem.console.rail", "{not json");
    expect(loadRail().collapsed).toBe(false);
  });
});

function Probe() {
  const s = useSidebar();
  return <div data-testid="p" data-w={s.width} data-collapsed={String(s.collapsed)} {...s.handleProps} />;
}
describe("useSidebar Cmd/Ctrl+B", () => {
  it("toggles collapsed and zeroes width", () => {
    render(<Probe />);
    const p = screen.getByTestId("p");
    expect(p.getAttribute("data-collapsed")).toBe("false");
    act(() => { fireEvent.keyDown(window, { key: "b", metaKey: true }); });
    expect(screen.getByTestId("p").getAttribute("data-collapsed")).toBe("true");
    expect(screen.getByTestId("p").getAttribute("data-w")).toBe("0");
  });
});
