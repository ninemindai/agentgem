import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { ToastProvider } from "../shell/Toast.js";
import { NotificationsProvider } from "./NotificationsProvider.js";
import { writeNotifyPref } from "./prefs.js";
import { writeWatchAlertPrefs } from "./watchAlertPrefs.js";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

// Sequences the three status endpoints across successive poll rounds.
function fetchScript(rounds: Array<{ warm: unknown; dream: unknown; attention?: unknown }>) {
  let round = 0;
  return vi.fn(async (url: string) => {
    const r = rounds[Math.min(round, rounds.length - 1)];
    const body = url.includes("/warm/") ? r.warm : url.includes("/dream/") ? r.dream : (r.attention ?? { sessions: [] });
    if (url.includes("/attention")) round++; // advance after ALL endpoints of a round are read
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
}

describe("NotificationsProvider", () => {
  it("does not toast on the first poll (baseline seed)", async () => {
    writeNotifyPref(true);
    vi.stubGlobal("fetch", fetchScript([{ warm: { running: true, last: null }, dream: { queued: 0 } }]));
    render(<ToastProvider><NotificationsProvider apiBase="" /></ToastProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/precomputed|review/i)).toBeNull();
  });

  it("toasts when a warm pass finishes (running true → false) while enabled + focused", async () => {
    writeNotifyPref(true);
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchScript([
      { warm: { running: true, last: null }, dream: { queued: 0 } },
      { warm: { running: false, last: null }, dream: { queued: 0 } },
    ]));
    render(<ToastProvider><NotificationsProvider apiBase="" /></ToastProvider>);
    await act(async () => { await Promise.resolve(); });        // first poll seeds baseline
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); // second poll → transition
    // Not findByText: with fake timers active, testing-library's waitFor
    // polls via a real setTimeout it never detects as faked (it only
    // recognizes Jest's fake timers), so it would hang forever. The toast
    // is already committed by the awaited advanceTimersByTimeAsync above.
    expect(screen.getByText(/precomputed/i)).toBeTruthy();
  });

  it("does nothing when the preference is off", async () => {
    writeNotifyPref(false);
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchScript([
      { warm: { running: true, last: null }, dream: { queued: 0 } },
      { warm: { running: false, last: null }, dream: { queued: 0 } },
    ]));
    render(<ToastProvider><NotificationsProvider apiBase="" /></ToastProvider>);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByText(/precomputed/i)).toBeNull();
  });

  const pendingSession = {
    id: "s1", file: "/t/s1.jsonl", project: "site",
    state: "pending", pendingKey: 4, pendingToolName: "Bash",
  };

  it("toasts when an enrolled session transitions into pending", async () => {
    writeNotifyPref(true);
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchScript([
      { warm: { running: false }, dream: { queued: 0 }, attention: { sessions: [{ ...pendingSession, state: "busy", pendingKey: null, pendingToolName: null }] } },
      { warm: { running: false }, dream: { queued: 0 }, attention: { sessions: [pendingSession] } },
    ]));
    render(<ToastProvider><NotificationsProvider apiBase="" /></ToastProvider>);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText(/waiting on approval for Bash/i)).toBeTruthy();
  });

  it("stays silent for a pending session that is not enrolled", async () => {
    writeNotifyPref(true);
    writeWatchAlertPrefs({ mode: "selected", files: [] }); // nothing enrolled
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchScript([
      { warm: { running: false }, dream: { queued: 0 }, attention: { sessions: [{ ...pendingSession, state: "busy", pendingKey: null, pendingToolName: null }] } },
      { warm: { running: false }, dream: { queued: 0 }, attention: { sessions: [pendingSession] } },
    ]));
    render(<ToastProvider><NotificationsProvider apiBase="" /></ToastProvider>);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByText(/waiting on approval/i)).toBeNull();
  });
});
