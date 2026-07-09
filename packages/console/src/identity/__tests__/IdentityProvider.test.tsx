import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { IdentityProvider, useIdentity } from "../IdentityProvider.js";
import * as routes from "../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Probe() {
  const { status, refresh } = useIdentity();
  return (
    <div>
      <span data-testid="login">{status === null ? "loading" : status.bound ? `@${status.login}` : "unbound"}</span>
      <button onClick={() => void refresh()}>refresh</button>
    </div>
  );
}

describe("IdentityProvider", () => {
  it("fetches bind status once on mount and exposes it", async () => {
    const call = vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    render(<IdentityProvider apiBase=""><Probe /></IdentityProvider>);
    expect(await screen.findByText("@bob")).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("refresh() re-fetches and propagates the new status to consumers", async () => {
    const call = vi.spyOn(routes.bindStatusRoute, "call")
      .mockResolvedValueOnce({ bound: false } as never)
      .mockResolvedValueOnce({ bound: true, login: "alice" } as never);
    render(<IdentityProvider apiBase=""><Probe /></IdentityProvider>);
    expect(await screen.findByText("unbound")).toBeTruthy();
    fireEvent.click(screen.getByText("refresh"));
    expect(await screen.findByText("@alice")).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("treats a failed status fetch as unbound rather than crashing the shell", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockRejectedValue(new Error("offline"));
    render(<IdentityProvider apiBase=""><Probe /></IdentityProvider>);
    expect(await screen.findByText("unbound")).toBeTruthy();
  });

  it("useIdentity() throws outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/must be used inside/);
  });

  it("does not poll even 60s after the initial fetch settles", async () => {
    const call = vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    render(<IdentityProvider apiBase=""><Probe /></IdentityProvider>);
    // Settle the initial fetch with real timers first — @testing-library's async
    // helpers (findByText/waitFor) don't play well with fake timers.
    await screen.findByText("unbound");

    // Now switch to fake timers and advance well past any plausible poll interval
    // (e.g. the 5s interval NotificationsProvider uses) to prove no setInterval
    // poll is running.
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }

    expect(call).toHaveBeenCalledTimes(1);
  });
});
