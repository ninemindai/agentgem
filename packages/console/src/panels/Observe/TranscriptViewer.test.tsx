import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TranscriptViewer } from "./TranscriptViewer.js";
import * as routes from "../../api/routes.js";
import type { TranscriptView } from "../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const view: TranscriptView = {
  sessionId: "s1", agent: "claude",
  meta: {
    agent: "claude", sessionId: "s1", project: "agentgem", model: "claude-opus-4-8",
    gitBranch: "main", startMs: 1000, endMs: 61000, msgs: 2,
    tokensIn: 100, tokensOut: 40, tokensCache: 15,
  },
  turns: [
    { id: "u1", role: "user", tsMs: 1000, tokens: { in: 0, out: 0, cache: 0 },
      spans: [{ kind: "message", role: "user", text: "do the thing" }] },
    { id: "a1", role: "assistant", tsMs: 6000, tokens: { in: 100, out: 40, cache: 15 },
      spans: [
        { kind: "message", role: "assistant", text: "on it" },
        { kind: "tool_call", name: "Read", input: "{ file_path: ~/x }", output: "contents here" },
      ] },
  ],
};

describe("TranscriptViewer", () => {
  it("renders turns and reveals tool I/O on expand", async () => {
    vi.spyOn(routes.inspectSessionRoute, "call").mockResolvedValue(view);
    render(<TranscriptViewer apiBase="" agent="claude" sessionId="s1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getAllByText("do the thing").length).toBeGreaterThan(0));
    // tool name visible, but its output is collapsed until clicked
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.queryByText("contents here")).toBeNull();
    fireEvent.click(screen.getByText("Read"));
    expect(screen.getByText("contents here")).toBeTruthy();
  });

  it("calls onBack when the back affordance is clicked", async () => {
    vi.spyOn(routes.inspectSessionRoute, "call").mockResolvedValue(view);
    const onBack = vi.fn();
    render(<TranscriptViewer apiBase="" agent="claude" sessionId="s1" onBack={onBack} />);
    await waitFor(() => expect(screen.getAllByText("do the thing").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("← Inspect"));
    expect(onBack).toHaveBeenCalled();
  });

  it("surfaces a load error instead of crashing", async () => {
    vi.spyOn(routes.inspectSessionRoute, "call").mockRejectedValue(new Error("nope"));
    render(<TranscriptViewer apiBase="" agent="claude" sessionId="s1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Couldn't load session/)).toBeTruthy());
  });

  it("distills the session and saves a draft", async () => {
    vi.spyOn(routes.inspectSessionRoute, "call").mockResolvedValue(view);
    const draft: routes.DistilledSkill = {
      name: "do-the-thing", description: "packages the thing", triggers: ["thing"], tools: ["Read"],
      mutating: false, body: "# steps", status: "draft", confidence: "high", origin: "llm",
      evidence: { sessions: 1, exampleSequence: ["Read"], root: "/work/app", provenance: { occurrences: [] } },
    };
    const distillSpy = vi.spyOn(routes.inspectDistillRoute, "call").mockResolvedValue({ distilled: [draft], lessons: [], degraded: false });
    vi.spyOn(routes.workflowDraftRoute, "call").mockResolvedValue({ path: "/work/app/.agentgem/distilled/do-the-thing/SKILL.md" });
    render(<TranscriptViewer apiBase="" agent="claude" sessionId="s1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getAllByText("do the thing").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByText(/Distill this session/));
    await waitFor(() => expect(screen.getByText("do-the-thing")).toBeTruthy());
    expect(distillSpy).toHaveBeenCalledWith(expect.anything(), { body: { id: "s1", agent: "claude" } });

    fireEvent.click(screen.getByText("Save draft"));
    await waitFor(() => expect(screen.getByText(/saved →/)).toBeTruthy());
  });

  it("offers a compare picker that navigates to the diff sub-route", async () => {
    vi.spyOn(routes.inspectSessionRoute, "call").mockResolvedValue(view);
    vi.spyOn(routes.observeRawRoute, "call").mockResolvedValue({ sessions: [
      { agent: "claude", sessionId: "s1", project: "agentgem", model: null, gitBranch: null, startMs: 0, endMs: 1, msgs: 1, tokensIn: 0, tokensOut: 0, tokensCache: 0 },
      { agent: "claude", sessionId: "other2", project: "proj-b", model: null, gitBranch: null, startMs: 0, endMs: 1, msgs: 1, tokensIn: 0, tokensOut: 0, tokensCache: 0 },
    ] });
    window.location.hash = "";
    render(<TranscriptViewer apiBase="" agent="claude" sessionId="s1" onBack={() => {}} />);
    const picker = await screen.findByLabelText(/compare with another session/i) as HTMLSelectElement;
    // current session is excluded; the other one is offered
    expect(screen.queryByRole("option", { name: /other2/ })).toBeTruthy();
    fireEvent.change(picker, { target: { value: "claude:other2" } });
    expect(window.location.hash).toBe("#/inspect/claude/s1?vs=claude:other2");
  });

  it("renders distilled lessons and saves one via /api/workflow/lesson", async () => {
    const lesson = { name: "pin-the-seed", body: "Pin the flaky test seed first.", importance: "high" as const, status: "draft" as const,
      evidence: { sessions: 1, root: "/work/app", provenance: { occurrences: [] } } };
    vi.spyOn(routes.inspectSessionRoute, "call").mockResolvedValue(view);
    vi.spyOn(routes.inspectDistillRoute, "call").mockResolvedValue({ distilled: [], lessons: [lesson], degraded: false });
    const saveSpy = vi.spyOn(routes.workflowLessonRoute, "call").mockResolvedValue({ path: "/work/app/.agentgem/distilled/lessons/pin-the-seed.md" });
    render(<TranscriptViewer apiBase="" agent="claude" sessionId="s1" onBack={vi.fn()} />);
    fireEvent.click(await screen.findByText(/Distill this session/));
    fireEvent.click(await screen.findByText("Save lesson"));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(expect.anything(), { body: lesson }));
    await screen.findByText(/saved →/);
  });

  it("hides the distill CTA for Codex sessions (Claude-only pipeline)", async () => {
    vi.spyOn(routes.inspectSessionRoute, "call").mockResolvedValue({ ...view, agent: "codex" });
    render(<TranscriptViewer apiBase="" agent="codex" sessionId="s1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getAllByText("do the thing").length).toBeGreaterThan(0));
    expect(screen.queryByText(/Distill this session/)).toBeNull();
  });
});
