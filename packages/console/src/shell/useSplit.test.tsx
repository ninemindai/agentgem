import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useSplit } from "./useSplit.js";

afterEach(() => { cleanup(); localStorage.clear(); });

function Host() {
  const s = useSplit("studio", { initial: 500, min: 300, max: 800 });
  return (
    <div data-testid="box" {...s.containerProps}>
      {s.handle}
    </div>
  );
}

describe("useSplit", () => {
  it("seeds --split from initial and persists keyboard resizes", () => {
    render(<Host />);
    const box = screen.getByTestId("box");
    expect(box.style.getPropertyValue("--split")).toBe("500px");
    const sep = box.querySelector('[role="separator"]') as HTMLElement;
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(box.style.getPropertyValue("--split")).toBe("516px");
    expect(localStorage.getItem("agentgem.console.split.studio")).toBe("516");
  });
  it("restores a saved size on mount", () => {
    localStorage.setItem("agentgem.console.split.studio", "640");
    render(<Host />);
    expect(screen.getByTestId("box").style.getPropertyValue("--split")).toBe("640px");
  });
  it("clamps an out-of-range saved size on mount", () => {
    localStorage.setItem("agentgem.console.split.studio", "5000");
    render(<Host />);
    expect(screen.getByTestId("box").style.getPropertyValue("--split")).toBe("800px");
  });
});
