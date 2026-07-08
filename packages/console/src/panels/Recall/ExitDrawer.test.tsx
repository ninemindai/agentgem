// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const SESSIONS = [
  { sessionId: "s1", agent: "claude" },
  { sessionId: "s2", agent: "codex" },
];

type Emit = (e: unknown) => void;
let scriptedEmit: Emit | null = null;

vi.mock("./recallStream.js", () => ({
  openRecallStream: (_apiBase: string, _jobId: string, onEvent: Emit) => {
    scriptedEmit = onEvent;
    return () => { scriptedEmit = null; };
  },
}));

vi.mock("../../api/routes.js", () => ({
  makeClient: (apiBase: string) => ({ apiBase }),
  recallRunRoute: { call: vi.fn(async () => ({ jobId: "j1" })) },
  recallCancelRoute: { call: vi.fn(async () => ({ ok: true })) },
}));

import { ExitDrawer } from "./ExitDrawer.js";
import { recallRunRoute, recallCancelRoute } from "../../api/routes.js";

afterEach(() => { cleanup(); vi.clearAllMocks(); scriptedEmit = null; });

// The scripted sequence the brief calls for: two sessions start, one answers
// well and one fails, a synthesis delta streams in, then `done` carries the
// final answers + synthesis.
function runScript(prompt = "hello") {
  scriptedEmit!({ type: "session_started", sessionId: "s1" });
  scriptedEmit!({ type: "session_started", sessionId: "s2" });
  scriptedEmit!({ type: "session_done", sessionId: "s1", answered: true });
  scriptedEmit!({ type: "session_done", sessionId: "s2", answered: false });
  scriptedEmit!({ type: "synthesis_delta", text: "hi" });
  scriptedEmit!({
    type: "done",
    answers: [
      { sessionId: "s1", agent: "claude", answered: true, answer: `finding for ${prompt}` },
      { sessionId: "s2", agent: "codex", answered: false, answer: "" },
    ],
    synthesis: "hi there — full synthesis",
  });
}

describe("ExitDrawer", () => {
  it("chat mode: shows two session chips (one failed) and the streamed synthesis", async () => {
    render(<ExitDrawer mode="chat" sessions={SESSIONS} apiBase="" onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText(/ask a (follow-up|question)/i), { target: { value: "how did this go?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(recallRunRoute.call).toHaveBeenCalledTimes(1));
    expect(scriptedEmit).not.toBeNull();
    runScript("how did this go?");

    await waitFor(() => expect(screen.getByText(/hi there — full synthesis/)).toBeTruthy());
    const chips = document.querySelectorAll(".rc-tool");
    expect(chips.length).toBe(2);
    expect(document.querySelectorAll(".rc-tool.ok").length).toBe(1);
    expect(document.querySelectorAll(".rc-tool.is-failed").length).toBe(1);
  });

  it("extract mode: renders the synthesis, per-session findings, and ReportActions", async () => {
    render(<ExitDrawer mode="extract" sessions={SESSIONS} apiBase="" onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText(/what do you want extracted/i), { target: { value: "every db command" } });
    fireEvent.click(screen.getByRole("button", { name: "Extract" }));

    await waitFor(() => expect(recallRunRoute.call).toHaveBeenCalledTimes(1));
    runScript("every db command");

    await waitFor(() => expect(screen.getByText(/hi there — full synthesis/)).toBeTruthy());
    expect(screen.getByText(/finding for every db command/)).toBeTruthy();
    expect(document.querySelectorAll(".rc-finding").length).toBe(1); // only the answered session
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("renders a 'scanned X of N' note when a capped event arrives", async () => {
    render(<ExitDrawer mode="chat" sessions={SESSIONS} apiBase="" onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText(/ask a (follow-up|question)/i), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(recallRunRoute.call).toHaveBeenCalledTimes(1));
    scriptedEmit!({ type: "session_started", sessionId: "s1" });
    scriptedEmit!({ type: "capped", scanned: 3, requested: 214, cap: 12 });

    await waitFor(() => expect(screen.getByText(/scanned 3 of 214/)).toBeTruthy());
  });

  it("cancels the running job on close", async () => {
    const onClose = vi.fn();
    render(<ExitDrawer mode="chat" sessions={SESSIONS} apiBase="" onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText(/ask a (follow-up|question)/i), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recallRunRoute.call).toHaveBeenCalledTimes(1));
    scriptedEmit!({ type: "session_started", sessionId: "s1" });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(recallCancelRoute.call).toHaveBeenCalledWith(expect.anything(), { path: { jobId: "j1" } });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
