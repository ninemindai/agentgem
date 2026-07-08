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

  it("unmount while the POST is still pending: no stream opens, the late-resolved job is cancelled, no setState-after-unmount warning", async () => {
    let resolvePost!: (v: { jobId: string }) => void;
    const pending = new Promise<{ jobId: string }>((resolve) => { resolvePost = resolve; });
    vi.mocked(recallRunRoute.call).mockReturnValueOnce(pending);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(<ExitDrawer mode="chat" sessions={SESSIONS} apiBase="" onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/ask a (follow-up|question)/i), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recallRunRoute.call).toHaveBeenCalledTimes(1));

    // Unmount BEFORE the POST resolves — teardown() runs while jobIdRef/closeStreamRef
    // are still null, so at unmount time it's a no-op besides flipping aliveRef.
    unmount();

    resolvePost({ jobId: "j1" });
    await pending;
    await Promise.resolve();
    await Promise.resolve();

    expect(scriptedEmit).toBeNull(); // openRecallStream never called for the unmounted run
    expect(recallCancelRoute.call).toHaveBeenCalledWith(expect.anything(), { path: { jobId: "j1" } });
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("double-submit before the first POST resolves: only the latest run's stream drives state, the stale job is cancelled", async () => {
    let resolveFirst!: (v: { jobId: string }) => void;
    let resolveSecond!: (v: { jobId: string }) => void;
    const firstPost = new Promise<{ jobId: string }>((resolve) => { resolveFirst = resolve; });
    const secondPost = new Promise<{ jobId: string }>((resolve) => { resolveSecond = resolve; });
    vi.mocked(recallRunRoute.call).mockReturnValueOnce(firstPost).mockReturnValueOnce(secondPost);

    render(<ExitDrawer mode="chat" sessions={SESSIONS} apiBase="" onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/ask a (follow-up|question)/i);

    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(recallRunRoute.call).toHaveBeenCalledTimes(1));

    // UX-layer guard: the Send button is disabled while a run is in flight.
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);

    // Second submit races in via Enter (the input itself stays enabled) before
    // the first POST has resolved — this is the re-entrancy the generation
    // guard in run() must catch even though the button is disabled.
    fireEvent.change(input, { target: { value: "second" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(recallRunRoute.call).toHaveBeenCalledTimes(2));

    // Resolve the stale first POST: superseded by gen, so its job is cancelled
    // and no stream opens for it.
    resolveFirst({ jobId: "j1" });
    await firstPost;
    await Promise.resolve();
    await Promise.resolve();
    expect(recallCancelRoute.call).toHaveBeenCalledWith(expect.anything(), { path: { jobId: "j1" } });

    // Resolve the current (second) POST: this one is allowed to open a stream.
    resolveSecond({ jobId: "j2" });
    await secondPost;
    await Promise.resolve();
    await Promise.resolve();
    expect(scriptedEmit).not.toBeNull();

    scriptedEmit!({ type: "session_started", sessionId: "s1" });
    scriptedEmit!({
      type: "done",
      answers: [
        { sessionId: "s1", agent: "claude", answered: true, answer: "finding for second" },
        { sessionId: "s2", agent: "codex", answered: false, answer: "" },
      ],
      synthesis: "second-turn synthesis",
    });

    await waitFor(() => expect(screen.getByText(/second-turn synthesis/)).toBeTruthy());
    // Both turns are recorded ("first" and "second" were each submitted), but
    // only "second" ever completed — the stale first stream never drove any
    // state, so its turn has no agent reply at all.
    const agentMsgs = document.querySelectorAll(".rc-msg--agent");
    expect(agentMsgs.length).toBe(1);
    expect(agentMsgs[0].textContent).toMatch(/second-turn synthesis/);
    const userMsgs = document.querySelectorAll(".rc-msg--user");
    expect(userMsgs.length).toBe(2);
  });
});
