import { describe, it, expect, beforeEach, vi } from "vitest";
import { transcriptToMsgs, loadStudioSession } from "../studioResume.js";
import { setStudioChat, getStudioChat } from "../studioChatStore.js";
import type { TranscriptTurn } from "../../../api/routes.js";

const turn = (t: Partial<TranscriptTurn> & { spans: TranscriptTurn["spans"] }): TranscriptTurn =>
  ({ id: "x", role: "user", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, ...t });

describe("transcriptToMsgs", () => {
  it("maps message + tool_call spans into studio msgs", () => {
    const turns: TranscriptTurn[] = [
      turn({ role: "user", spans: [{ kind: "message", role: "user", text: "make it blue" }] }),
      turn({ role: "assistant", spans: [
        { kind: "tool_call", name: "Edit", input: "{}", output: "ok" },
        { kind: "message", role: "assistant", text: "done" },
      ] }),
    ];
    expect(transcriptToMsgs(turns)).toEqual([
      { role: "user", text: "make it blue" },
      { role: "tool", title: "Edit", failed: false },
      { role: "agent", text: "done" },
    ]);
  });

  it("strips the injected brief from the first user message", () => {
    const turns: TranscriptTurn[] = [
      turn({ role: "user", spans: [{ kind: "message", role: "user", text: "SYSTEM BRIEF TEXT\n\n---\nUser: build a timer" }] }),
    ];
    expect(transcriptToMsgs(turns)).toEqual([{ role: "user", text: "build a timer" }]);
  });

  it("marks failed tool calls", () => {
    const turns: TranscriptTurn[] = [
      turn({ role: "assistant", spans: [{ kind: "tool_call", name: "Bash", input: "x", error: true }] }),
    ];
    expect(transcriptToMsgs(turns)).toEqual([{ role: "tool", title: "Bash", failed: true }]);
  });

  // eng-review C3: strip on FIRST marker only, and only on turn 0, so a later user
  // message that legitimately contains the marker text is left intact.
  it("strips only the first marker and only the first user turn", () => {
    const turns: TranscriptTurn[] = [
      turn({ role: "user", spans: [{ kind: "message", role: "user", text: "BRIEF\n---\nUser: first" }] }),
      turn({ role: "user", spans: [{ kind: "message", role: "user", text: "here is a log\n---\nUser: kept literally" }] }),
    ];
    expect(transcriptToMsgs(turns)).toEqual([
      { role: "user", text: "first" },
      { role: "user", text: "here is a log\n---\nUser: kept literally" },
    ]);
  });
});

// A valid TranscriptView.meta (ObserveRawSchema.shape.sessions.element). The typed
// route validates the response, so `meta: {}` would fail and yield empty msgs.
const meta = {
  agent: "claude", sessionId: "sess_1", project: null, model: null, gitBranch: null,
  startMs: 0, endMs: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0,
};

// inspectSessionRoute (a @agentback/client typed route) reads response.text() and
// JSON.parses it; the /state call is a plain fetch reading .json(). Provide both.
function mockFetch(routes: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const path = new URL(url, "http://x").pathname;
    const hit = Object.entries(routes).find(([p]) => path.endsWith(p) || path.includes(p));
    const body = hit ? hit[1] : {};
    const payload = JSON.stringify(body);
    return { ok: !!hit, status: hit ? 200 : 404, text: async () => payload, json: async () => body } as any;
  });
}

describe("loadStudioSession", () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } vi.restoreAllMocks(); });

  it("returns empty when nothing stored", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    expect(await loadStudioSession("", "demo")).toEqual({ msgs: [], chatId: null, sessionId: null, running: false });
  });

  it("renders history + keeps chatId when the session is alive and running", async () => {
    setStudioChat("demo", { chatId: "chat_1", sessionId: "sess_1", agent: "claude" });
    vi.stubGlobal("fetch", mockFetch({
      "/api/inspect/session": { sessionId: "sess_1", agent: "claude", meta, turns: [
        { id: "1", role: "user", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, spans: [{ kind: "message", role: "user", text: "hi" }] },
      ] },
      "/api/chat/chat_1/state": { alive: true, running: true, sessionId: "sess_1", agent: "claude" },
    }));
    const r = await loadStudioSession("", "demo");
    expect(r).toMatchObject({ chatId: "chat_1", sessionId: "sess_1", running: true });
    expect(r.msgs).toEqual([{ role: "user", text: "hi" }]);
  });

  it("drops chatId (fresh continue) when the session is dead but keeps history", async () => {
    setStudioChat("demo", { chatId: "chat_gone", sessionId: "sess_1", agent: "claude" });
    vi.stubGlobal("fetch", mockFetch({
      "/api/inspect/session": { sessionId: "sess_1", agent: "claude", meta, turns: [
        { id: "1", role: "assistant", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, spans: [{ kind: "message", role: "assistant", text: "old reply" }] },
      ] },
      "/api/chat/chat_gone/state": { alive: false },
    }));
    const r = await loadStudioSession("", "demo");
    expect(r).toMatchObject({ chatId: null, sessionId: "sess_1", running: false });
    expect(r.msgs).toEqual([{ role: "agent", text: "old reply" }]);
    expect(getStudioChat("demo")?.chatId).toBe(""); // clearChatId applied
  });
});
