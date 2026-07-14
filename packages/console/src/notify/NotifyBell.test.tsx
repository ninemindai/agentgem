import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { NotifyBell } from "./NotifyBell.js";
import { readNotifyPref, writeNotifyPref } from "./prefs.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe("NotifyBell", () => {
  it("starts on by default when the Electron bridge is present", () => {
    vi.stubGlobal("agentgem", { notify: vi.fn() });
    render(<NotifyBell />);
    // On the desktop the native bridge needs no permission, so notifications are on out of the box.
    expect(screen.getByRole("button", { name: /turn off/i })).toBeTruthy();
    expect(readNotifyPref()).toBe(true);
  });

  it("enables directly (no prompt) when the Electron bridge is present", () => {
    vi.stubGlobal("agentgem", { notify: vi.fn() });
    writeNotifyPref(false); // explicitly off, to exercise the enable path
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
    const btn = screen.getByRole("button", { name: /blocked/i });
    expect(btn.className).toContain("is-blocked");
  });

  it("toggles off from the desktop default-on state", () => {
    vi.stubGlobal("agentgem", { notify: vi.fn() });
    render(<NotifyBell />); // starts on (native bridge default)
    fireEvent.click(screen.getByRole("button", { name: /notification/i })); // off
    expect(readNotifyPref()).toBe(false);
  });
});
