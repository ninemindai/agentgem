import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { NotifyBell } from "./NotifyBell.js";
import { readNotifyPref } from "./prefs.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe("NotifyBell", () => {
  it("enables directly (no prompt) when the Electron bridge is present", () => {
    vi.stubGlobal("agentgem", { notify: vi.fn() });
    render(<NotifyBell />);
    fireEvent.click(screen.getByRole("button", { name: /notification/i }));
    expect(readNotifyPref()).toBe(true);
  });

  it("requests browser permission on first enable and turns on when granted", async () => {
    vi.stubGlobal("agentgem", undefined);
    const req = vi.fn(async () => "granted");
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission: req }));
    render(<NotifyBell />);
    fireEvent.click(screen.getByRole("button", { name: /notification/i }));
    await waitFor(() => expect(req).toHaveBeenCalled());
    await waitFor(() => expect(readNotifyPref()).toBe(true));
  });

  it("stays off when browser permission is denied", async () => {
    vi.stubGlobal("agentgem", undefined);
    const req = vi.fn(async () => "denied");
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission: req }));
    render(<NotifyBell />);
    fireEvent.click(screen.getByRole("button", { name: /notification/i }));
    await waitFor(() => expect(req).toHaveBeenCalled());
    expect(readNotifyPref()).toBe(false);
  });

  it("toggles back off when already enabled", () => {
    vi.stubGlobal("agentgem", { notify: vi.fn() });
    render(<NotifyBell />);
    const btn = screen.getByRole("button", { name: /notification/i });
    fireEvent.click(btn); // on
    fireEvent.click(btn); // off
    expect(readNotifyPref()).toBe(false);
  });
});
