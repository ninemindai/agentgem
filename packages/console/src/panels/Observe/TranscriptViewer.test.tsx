import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TranscriptViewer, DraftCard, LessonCard } from "./TranscriptViewer.js";
import * as routes from "../../api/routes.js";
import type { TranscriptView, DistilledLesson } from "../../api/routes.js";

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
    // Map is the default structure view; switch to Transcript for the verbatim turn tree.
    fireEvent.click(screen.getByRole("button", { name: /transcript/i }));
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
    fireEvent.click(screen.getByText("← Overview"));
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

  it("edits the trigger contract and posts the edited draft", async () => {
    const draft = {
      name: "do-x", description: "d", triggers: ["t"], tools: [], mutating: false, body: "b",
      evidence: { sessions: 1, exampleSequence: [], root: "/r", provenance: { occurrences: [] } },
      status: "draft" as const, confidence: "high" as const, origin: "llm" as const,
      triggerContract: { intent: "do x", triggers: ["save"], antiTriggers: [] },
    };
    const spy = vi.spyOn(routes.workflowDraftRoute, "call").mockResolvedValue({ path: "/p" } as any);
    render(<DraftCard apiBase="" draft={draft} />);
    fireEvent.change(screen.getByLabelText("triggers"), { target: { value: "save, share" } });
    fireEvent.click(screen.getByRole("button", { name: /save draft/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const body = spy.mock.calls[0][1].body;
    expect(body.triggerContract!.triggers).toEqual(["save", "share"]);
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

  it("hides the distill CTA for a trivial session with nothing to distill", async () => {
    const trivial: TranscriptView = {
      ...view,
      turns: [
        { id: "u1", role: "user", tsMs: 1000, tokens: { in: 0, out: 0, cache: 0 }, spans: [{ kind: "message", role: "user", text: "hi" }] },
        { id: "a1", role: "assistant", tsMs: 2000, tokens: { in: 1, out: 1, cache: 0 }, spans: [{ kind: "message", role: "assistant", text: "hello" }] },
      ],
    };
    vi.spyOn(routes.inspectSessionRoute, "call").mockResolvedValue(trivial);
    render(<TranscriptViewer apiBase="" agent="claude" sessionId="s1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getAllByText("hi").length).toBeGreaterThan(0));
    expect(screen.queryByText(/Distill this session/)).toBeNull();
  });

  it("shows ACP guidance (not an API key) when distillation is degraded", async () => {
    vi.spyOn(routes.inspectSessionRoute, "call").mockResolvedValue(view);
    vi.spyOn(routes.inspectDistillRoute, "call").mockResolvedValue({ distilled: [], lessons: [], degraded: true });
    render(<TranscriptViewer apiBase="" agent="claude" sessionId="s1" onBack={() => {}} />);
    fireEvent.click(await screen.findByText(/Distill this session/));
    await waitFor(() => expect(screen.getByText(/Claude ACP agent/)).toBeTruthy());
    expect(screen.queryByText(/ANTHROPIC_API_KEY/)).toBeNull();
  });

  it("hides the distill CTA for Codex sessions (Claude-only pipeline)", async () => {
    vi.spyOn(routes.inspectSessionRoute, "call").mockResolvedValue({ ...view, agent: "codex" });
    render(<TranscriptViewer apiBase="" agent="codex" sessionId="s1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getAllByText("do the thing").length).toBeGreaterThan(0));
    expect(screen.queryByText(/Distill this session/)).toBeNull();
  });

  it("deep-links to a turn: forces transcript mode, expands it, and scrolls it into view", async () => {
    vi.spyOn(routes.inspectSessionRoute, "call").mockResolvedValue(view);
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    render(<TranscriptViewer apiBase="" agent="claude" sessionId="s1" onBack={() => {}} turn={1} />);

    // Transcript (tx) mode is forced, not the default Map — the turn tree renders directly.
    await waitFor(() => expect(screen.getByText("Read")).toBeTruthy());
    // The targeted turn (index 1, "a1") is expanded: "on it" renders both in the
    // collapsed-header preview and in the expanded span body — two matches proves
    // the spans are showing, not just the header (a collapsed turn would be one).
    expect(screen.getAllByText("on it").length).toBe(2);
    // Scrolled the anchored turn element into view.
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith(expect.objectContaining({ block: "center" })));
    const target = document.getElementById("turn-a1");
    expect(target).toBeTruthy();
    expect(scrollSpy.mock.instances).toContain(target);
  });

  it("ignores an out-of-range deep-linked turn (no crash, no scroll)", async () => {
    vi.spyOn(routes.inspectSessionRoute, "call").mockResolvedValue(view);
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    render(<TranscriptViewer apiBase="" agent="claude" sessionId="s1" onBack={() => {}} turn={99} />);

    // Falls back to the default Map view since there's no valid turn to deep-link to.
    await waitFor(() => expect(screen.getAllByText("do the thing").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: /◆ Map/ }).className).toContain("on");
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});

describe("LessonCard share link", () => {
  const lesson: DistilledLesson = {
    name: "prefer-rg", body: "use rg not grep", importance: "high", status: "draft",
    evidence: { sessions: 1, root: "/work/app", provenance: { occurrences: [] } },
  };

  it("mints a gem card for the lesson via Share link", async () => {
    const createGemShare = vi.fn(async () => ({ id: "l1", url: "https://agentgem.ai/share/l1" }));
    render(<LessonCard apiBase="" lesson={lesson} createGemShare={createGemShare} />);
    fireEvent.click(screen.getByRole("button", { name: /share link/i }));
    await waitFor(() => expect(createGemShare).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "gem", name: "prefer-rg" }),
    ));
  });
});
