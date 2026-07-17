import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useCountUp } from "./useCountUp.js";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function Probe({ targets }: { targets: number[] }) {
  const display = useCountUp(targets);
  return <div data-testid="vals">{display.join(",")}</div>;
}

describe("useCountUp", () => {
  it("ticks from 0 up to the exact final values, driven by one shared rAF loop", () => {
    vi.useFakeTimers();
    const { getByTestId } = render(<Probe targets={[10, 20, 300]} />);
    expect(getByTestId("vals").textContent).toBe("0,0,0");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(getByTestId("vals").textContent).toBe("10,20,300");
  });

  it("ticks from the previously displayed values (a stale prefill) to a new target, not from 0", () => {
    vi.useFakeTimers();
    const { getByTestId, rerender } = render(<Probe targets={[5, 5]} />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(getByTestId("vals").textContent).toBe("5,5");

    rerender(<Probe targets={[50, 60]} />);
    // Immediately after the target changes the displayed row hasn't jumped to 0 —
    // it's still the last frame (5,5), the new leg's starting point.
    expect(getByTestId("vals").textContent).toBe("5,5");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(getByTestId("vals").textContent).toBe("50,60");
  });

  it("skips the animation under prefers-reduced-motion and renders final values immediately", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q }) as MediaQueryList);
    const { getByTestId } = render(<Probe targets={[7, 8]} />);
    expect(getByTestId("vals").textContent).toBe("7,8");
  });
});
