import { useState } from "react";
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

// Exercises disconnect() and surfaces both outcomes (applied status, or a rejection
// the caller can catch) as text, the same way Settings' disconnectGitHub does.
function DisconnectProbe() {
  const { status, disconnect } = useIdentity();
  const [outcome, setOutcome] = useState("idle");
  const run = () => {
    disconnect()
      .then(() => setOutcome("resolved"))
      .catch((e: unknown) => setOutcome(`rejected: ${e instanceof Error ? e.message : String(e)}`));
  };
  return (
    <div>
      <span data-testid="login">{status === null ? "loading" : status.bound ? `@${status.login}` : "unbound"}</span>
      <span data-testid="outcome">{outcome}</span>
      <button onClick={run}>disconnect</button>
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

  it("never registers a setInterval poll", async () => {
    const call = vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    render(<IdentityProvider apiBase=""><Probe /></IdentityProvider>);
    // React flushes the mount effect synchronously inside render()'s act(), so
    // any setInterval a poll would register is already visible here. Check
    // *before* settling with findByText: @testing-library's own waitFor
    // machinery registers its own real-timer fallback setInterval internally,
    // which would otherwise show up as a false positive.
    expect(intervalSpy).not.toHaveBeenCalled();

    await screen.findByText("unbound");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("disconnect() applies the route's returned record to the context", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    vi.spyOn(routes.bindDisconnectRoute, "call").mockResolvedValue({ bound: false } as never);
    render(<IdentityProvider apiBase=""><DisconnectProbe /></IdentityProvider>);
    expect(await screen.findByText("@bob")).toBeTruthy();
    fireEvent.click(screen.getByText("disconnect"));
    expect(await screen.findByText("unbound")).toBeTruthy();
    expect(await screen.findByText("resolved")).toBeTruthy();
  });

  it("disconnect() rejects when the route throws, so the caller can catch it", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    vi.spyOn(routes.bindDisconnectRoute, "call").mockRejectedValue(new Error("network down"));
    render(<IdentityProvider apiBase=""><DisconnectProbe /></IdentityProvider>);
    expect(await screen.findByText("@bob")).toBeTruthy();
    fireEvent.click(screen.getByText("disconnect"));
    expect(await screen.findByText("rejected: network down")).toBeTruthy();
    // The failed disconnect must not clobber the still-bound status.
    expect(screen.getByText("@bob")).toBeTruthy();
  });
});
