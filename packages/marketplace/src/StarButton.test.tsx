import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { StarButton } from "./StarButton";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const apiWith = (toggle: () => Promise<{ starred: boolean; count: number }>) => ({ get: async () => ({ counts: {}, mine: [] }), toggle }) as never;

describe("StarButton", () => {
  it("renders the count and reflects starred state", () => {
    render(<StarButton kind="gem" id="x" count={3} starred={true} signedIn={true} loginUrl={() => "/login"} api={apiWith(async () => ({ starred: false, count: 2 }))} />);
    expect(screen.getByRole("button", { name: /star/i }).textContent).toContain("3");
  });
  it("syncs to count/starred props that arrive after mount (post-fetch)", () => {
    // Pages mount the button before the star-fetch resolves, then re-render with
    // real counts/mine. useState only reads props at mount, so without a sync
    // effect the button would stay stuck at the initial 0/unstarred.
    const props = { kind: "gem", id: "x", signedIn: true, loginUrl: () => "/login", api: apiWith(async () => ({ starred: false, count: 0 })) };
    const { rerender } = render(<StarButton {...props} count={0} starred={false} />);
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false");
    act(() => { rerender(<StarButton {...props} count={5} starred={true} />); });
    const btn = screen.getByRole("button");
    expect(btn.textContent).toContain("5");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });
  it("signed-in click optimistically toggles then reconciles with the server count", async () => {
    const toggle = vi.fn(async () => ({ starred: true, count: 4 }));
    render(<StarButton kind="gem" id="x" count={3} starred={false} signedIn={true} loginUrl={() => "/login"} api={apiWith(toggle)} />);
    fireEvent.click(screen.getByRole("button", { name: /star/i }));
    await waitFor(() => expect(toggle).toHaveBeenCalledWith("gem", "x"));
    await waitFor(() => expect(screen.getByRole("button").textContent).toContain("4"));
  });
  it("signed-out click navigates to loginUrl (no toggle)", () => {
    const toggle = vi.fn();
    const assign = vi.fn();
    vi.stubGlobal("location", { assign } as unknown as Location);
    render(<StarButton kind="gem" id="x" count={3} starred={false} signedIn={false} loginUrl={() => "/login?return=here"} api={apiWith(toggle as never)} />);
    fireEvent.click(screen.getByRole("button", { name: /star/i }));
    expect(toggle).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith("/login?return=here");
  });
});
