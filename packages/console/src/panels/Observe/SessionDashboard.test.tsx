// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/SessionDashboard.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { SessionDashboard } from "./SessionDashboard.js";
import * as stream from "./dashboardStream.js";
import type { SessionDashboardEvent } from "./dashboardStream.js";

beforeEach(() => { cleanup(); vi.restoreAllMocks(); });

function mockStream() {
  let handler: ((e: SessionDashboardEvent) => void) | null = null;
  const close = vi.fn();
  const spy = vi.spyOn(stream, "openSessionDashboardStream").mockImplementation((_c, _p, onEvent) => {
    handler = onEvent;
    return close;
  });
  return { spy, close, emit: (e: SessionDashboardEvent) => act(() => handler?.(e)) };
}

describe("SessionDashboard", () => {
  it("shows generation progress, then the sealed dashboard frame", async () => {
    const s = mockStream();
    render(<SessionDashboard apiBase="/" agent="claude" sessionId="s1" />);
    s.emit({ type: "start", cached: false, events: 42 });
    expect(screen.getByText(/Generating summary/)).toBeTruthy();
    s.emit({ type: "done", html: "<section>hi</section>", cached: false, updatedAt: 1_752_598_000_000 });
    const frame = document.querySelector("iframe.sd-frame") as HTMLIFrameElement;
    expect(frame).toBeTruthy();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");        // sealed: no allow-same-origin
    expect(frame.getAttribute("srcdoc")).toContain("hi");
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy"); // sandboxDoc CSP applied
  });

  it("serves a cached dashboard with a Regenerate affordance that reopens fresh", async () => {
    const s = mockStream();
    render(<SessionDashboard apiBase="/" agent="claude" sessionId="s1" />);
    s.emit({ type: "done", html: "<b>cached</b>", cached: true, updatedAt: 1_752_598_000_000 });
    expect(screen.getByText(/cached ·/)).toBeTruthy();
    expect(s.spy).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ fresh: false }), expect.any(Function));
    fireEvent.click(screen.getByRole("button", { name: /regenerate/i }));
    expect(s.spy).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ fresh: true }), expect.any(Function));
  });

  it("surfaces failures with a retry", async () => {
    const s = mockStream();
    render(<SessionDashboard apiBase="/" agent="claude" sessionId="s1" />);
    s.emit({ type: "failed", message: "dashboard rendering failed — is the local coding agent available?" });
    expect(screen.getByText(/rendering failed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("opens the stream for codex sessions too", () => {
    const s = mockStream();
    render(<SessionDashboard apiBase="/" agent="codex" sessionId="c1" />);
    expect(s.spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "c1", agent: "codex" }), expect.any(Function));
  });

  it("switches to the Report kind and reopens the stream for it", async () => {
    const s = mockStream();
    render(<SessionDashboard apiBase="/" agent="claude" sessionId="s1" />);
    expect(s.spy).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kind: "summary" }), expect.any(Function));
    s.emit({ type: "done", html: "<b>sum</b>", cached: true, updatedAt: 1 });
    fireEvent.click(screen.getByRole("tab", { name: /report/i }));
    expect(s.spy).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kind: "report" }), expect.any(Function));
    s.emit({ type: "done", html: "<h1>report</h1>", cached: false, updatedAt: 2 });
    const frame = document.querySelector("iframe.sd-frame.is-report") as HTMLIFrameElement;
    expect(frame).toBeTruthy();                                  // report gets the tall document frame
    expect(frame.getAttribute("srcdoc")).toContain("report");
  });
});
