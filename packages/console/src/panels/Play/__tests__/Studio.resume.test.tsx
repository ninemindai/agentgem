// packages/console/src/panels/Play/__tests__/Studio.resume.test.tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { Studio } from "../Studio.js";
import { setStudioChat, getStudioChat } from "../studioChatStore.js";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";
import { playMiniappRoute } from "../../../api/routes.js";
import { openStudioStream } from "../studioStream.js";

// A dropped EventSource ("connection lost", from studioStream.ts's own error listener) must be
// reconciled via /state, not rendered as a failure — the turn keeps running server-side (Task 3).
// Mocking the module lets us drive onFailed synchronously without a real EventSource in jsdom.
vi.mock("../studioStream.js", () => ({
  openStudioStream: vi.fn((_apiBase: string, _chatId: string, _message: string, h: { onFailed: (e: string) => void }) => {
    h.onFailed("connection lost");
    return () => {};
  }),
}));

afterEach(() => { cleanup(); try { localStorage.clear(); } catch { /* ignore */ } vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const codex = [{ id: "codex", name: "Codex", available: true }];

const inspectMeta = (sessionId: string) => ({
  agent: "codex", sessionId, project: null, model: null, gitBranch: null,
  startMs: 0, endMs: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0,
});

// Routes raw fetch by pathname; DELETE calls are recorded on the returned fn for assertion.
function routeFetch(map: Record<string, unknown>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://x").pathname;
    if (init?.method === "DELETE") { (fn as unknown as { deleted?: string }).deleted = path; return { ok: true, json: async () => ({ ok: true }) } as unknown as Response; }
    const hit = Object.entries(map).find(([p]) => path.includes(p));
    const body = hit ? hit[1] : {};
    return { ok: !!hit, status: hit ? 200 : 404, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
  });
  return fn;
}

describe("Studio resume", () => {
  it("restores history from the durable transcript on mount", async () => {
    setStudioChat("demo", { chatId: "chat_1", sessionId: "sess_1", agent: "codex" });
    vi.stubGlobal("fetch", routeFetch({
      "/api/inspect/session": { sessionId: "sess_1", agent: "codex", meta: {
        agent: "codex", sessionId: "sess_1", project: null, model: null, gitBranch: null,
        startMs: 0, endMs: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0,
      }, turns: [
        { id: "1", role: "user", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, spans: [{ kind: "message", role: "user", text: "make a timer" }] },
      ] },
      "/api/chat/chat_1/state": { alive: false },
    }));
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "demo", html: "<p>x</p>",
      meta: { title: "Demo", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
    } as never);

    render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

    await waitFor(() => expect(screen.getByText("make a timer")).toBeTruthy());
    // dead session → chatId cleared, but sessionId kept for history; the Stop button reflects no live session.
    expect(screen.queryByTitle("kill the agent session")).toBeNull();
  });

  it("shows a resuming spinner and Stop while a background turn is still running, then Stop kills it", async () => {
    setStudioChat("demo2", { chatId: "chat_2", sessionId: "sess_2", agent: "codex" });
    const fetchMock = routeFetch({
      "/api/inspect/session": { sessionId: "sess_2", agent: "codex", meta: {
        agent: "codex", sessionId: "sess_2", project: null, model: null, gitBranch: null,
        startMs: 0, endMs: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0,
      }, turns: [] },
      "/api/chat/chat_2/state": { alive: true, running: true },
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "demo2", html: "<p>x</p>",
      meta: { title: "Demo2", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
    } as never);

    render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo2" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

    // Stop is shown because a live chatId is restored.
    const stopBtn = await screen.findByTitle("kill the agent session");
    expect(await screen.findByText(/resuming…/i)).toBeTruthy();

    fireEvent.click(stopBtn);
    await waitFor(() => expect((fetchMock as unknown as { deleted?: string }).deleted).toBe("/api/chat/chat_2"));
    await waitFor(() => expect(screen.getByText("session stopped")).toBeTruthy());
    expect(screen.queryByTitle("kill the agent session")).toBeNull();
    // sessionId kept (only chatId cleared) so history would still resolve on a later mount.
    expect(getStudioChat("demo2")?.sessionId).toBe("sess_2");
    expect(getStudioChat("demo2")?.chatId).toBe("");
  });

  it("reconciles via /state instead of failing when the stream reports a transient transport drop", async () => {
    setStudioChat("demo3", { chatId: "chat_3", sessionId: "sess_3", agent: "codex" });
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url, "http://x").pathname;
      if (path === "/api/inspect/session") {
        return { ok: true, json: async () => ({ sessionId: "sess_3", agent: "codex", meta: {
          agent: "codex", sessionId: "sess_3", project: null, model: null, gitBranch: null,
          startMs: 0, endMs: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0,
        }, turns: [] }) } as unknown as Response;
      }
      // Alive-but-idle at mount so chatId survives without the mount effect itself entering the poll path.
      if (path === "/api/chat/chat_3/state") return { ok: true, json: async () => ({ alive: true, running: false }) } as unknown as Response;
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "demo3", html: "<p>x</p>",
      meta: { title: "Demo3", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
    } as never);

    render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo3" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

    // chatId restored (alive) → Stop is already visible before any send.
    const stopBtn = await screen.findByTitle("kill the agent session");
    const sendBtn = screen.getByRole("button", { name: "Send" });
    fireEvent.change(screen.getByPlaceholderText(/ask the agent/i), { target: { value: "keep going" } });
    fireEvent.click(sendBtn);

    // openStudioStream's mock synchronously fires onFailed("connection lost"); the fix must treat
    // that like "already running" — reconcile via pollWhileRunning, not render a failed chip.
    await screen.findByText(/resuming…/i);
    expect(screen.queryByText(/failed: connection lost/i)).toBeNull();
    expect(screen.getByTitle("kill the agent session")).toBe(stopBtn);
  });

  it("surfaces new transcript spans while a background turn is still running", async () => {
    vi.useFakeTimers();
    try {
      setStudioChat("demo4", { chatId: "chat_4", sessionId: "sess_4", agent: "codex" });
      let turns: unknown[] = []; // grows on the 2nd inspect read
      const base = {
        agent: "codex", sessionId: "sess_4", project: null, model: null, gitBranch: null,
        startMs: 0, endMs: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0,
      };
      const fetchMock = vi.fn(async (url: string) => {
        const path = new URL(url, "http://x").pathname;
        if (path.includes("/api/inspect/session")) {
          const body = { sessionId: "sess_4", agent: "codex", meta: base, turns };
          turns = [{ id: "1", role: "assistant", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, spans: [{ kind: "message", role: "assistant", text: "wiring it up…" }] }];
          return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
        }
        if (path.includes("/api/chat/chat_4/state")) return { ok: true, json: async () => ({ alive: true, running: true }) } as unknown as Response;
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
        name: "demo4", html: "<p>x</p>",
        meta: { title: "Demo4", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
      } as never);

      render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo4" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

      // Mount resume shows the reconnecting label first; nothing built yet.
      await vi.waitFor(() => expect(screen.getByText(/resuming…/i)).toBeTruthy());
      // First still-running tick (1.5s) refreshes the transcript → the new span renders and the label flips to working.
      await vi.advanceTimersByTimeAsync(1600);
      await vi.waitFor(() => expect(screen.getByText("wiring it up…")).toBeTruthy());
      expect(screen.getByText(/working…/i)).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it("keeps polling (no give-up lock) after many ticks while still running", async () => {
    vi.useFakeTimers();
    try {
      setStudioChat("demo5", { chatId: "chat_5", sessionId: "sess_5", agent: "codex" });
      const fetchMock = routeFetch({
        "/api/inspect/session": { sessionId: "sess_5", agent: "codex", meta: {
          agent: "codex", sessionId: "sess_5", project: null, model: null, gitBranch: null,
          startMs: 0, endMs: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0,
        }, turns: [] },
        "/api/chat/chat_5/state": { alive: true, running: true },
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
        name: "demo5", html: "<p>x</p>",
        meta: { title: "Demo5", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
      } as never);

      render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo5" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

      await vi.advanceTimersByTimeAsync(0); // flush the mount effect's fetch chain
      const stopBtn = screen.getByTitle("kill the agent session");
      // Advance well past the old ~10-min cap; the spinner must still be live and Stop must still recover.
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(screen.getByText(/working…/i)).toBeTruthy();
      fireEvent.click(stopBtn);
      await vi.waitFor(() => expect((fetchMock as unknown as { deleted?: string }).deleted).toBe("/api/chat/chat_5"));
      await vi.waitFor(() => expect(screen.getByText("session stopped")).toBeTruthy());
      // Stop invalidated the poll generation: a stale tick must neither resurrect the
      // spinner nor keep fetching.
      const callsAfterStop = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock.mock.calls.length).toBe(callsAfterStop);
      expect(screen.queryByText(/working…/i)).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("clears busy and renders the final transcript when the turn completes (regression: never-unlocks)", async () => {
    vi.useFakeTimers();
    try {
      setStudioChat("demo6", { chatId: "chat_6", sessionId: "sess_6", agent: "codex" });
      let stateCalls = 0;
      const finalTurns = [{ id: "1", role: "assistant", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, spans: [{ kind: "message", role: "assistant", text: "all done" }] }];
      const fetchMock = vi.fn(async (url: string) => {
        const path = new URL(url, "http://x").pathname;
        if (path.includes("/api/chat/chat_6/state")) {
          stateCalls++; // mount read + tick 1 report running; tick 2 reports done
          return { ok: true, json: async () => ({ alive: true, running: stateCalls <= 2 }) } as unknown as Response;
        }
        if (path.includes("/api/inspect/session")) {
          const body = { sessionId: "sess_6", agent: "codex", meta: inspectMeta("sess_6"), turns: stateCalls >= 2 ? finalTurns : [] };
          return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
        name: "demo6", html: "<p>x</p>",
        meta: { title: "Demo6", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
      } as never);

      render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo6" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

      await vi.waitFor(() => expect(screen.getByText(/resuming…/i)).toBeTruthy());
      await vi.advanceTimersByTimeAsync(5000); // tick 1 running → tick 2 sees running:false
      await vi.waitFor(() => expect(screen.getByText("all done")).toBeTruthy());
      expect(screen.queryByText(/working…|resuming…/i)).toBeNull(); // spinner gone
      fireEvent.change(screen.getByPlaceholderText(/ask the agent/i), { target: { value: "one more thing" } });
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false); // busy cleared: Send is enabled again
    } finally { vi.useRealTimers(); }
  });

  it("does not drop the optimistic user message while the transcript is behind (growth-only guard)", async () => {
    vi.useFakeTimers();
    try {
      setStudioChat("demo7", { chatId: "chat_7", sessionId: "sess_7", agent: "codex" });
      let mounted = false;
      const fetchMock = vi.fn(async (url: string) => {
        const path = new URL(url, "http://x").pathname;
        if (path.includes("/api/chat/chat_7/state")) {
          const running = mounted; mounted = true; // idle at mount; running for the send-reconcile poll
          return { ok: true, json: async () => ({ alive: true, running }) } as unknown as Response;
        }
        if (path.includes("/api/inspect/session")) {
          const body = { sessionId: "sess_7", agent: "codex", meta: inspectMeta("sess_7"), turns: [] }; // never catches up
          return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
        name: "demo7", html: "<p>x</p>",
        meta: { title: "Demo7", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
      } as never);

      render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo7" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

      await vi.advanceTimersByTimeAsync(0); // flush the mount effect's fetch chain
      const sendBtn = screen.getByRole("button", { name: "Send" });
      fireEvent.change(screen.getByPlaceholderText(/ask the agent/i), { target: { value: "keep going" } });
      fireEvent.click(sendBtn); // stream mock fires onFailed("connection lost") → reconcile-poll
      await vi.waitFor(() => expect(screen.getByText(/resuming…/i)).toBeTruthy());
      await vi.advanceTimersByTimeAsync(3200); // two ticks with an empty (behind) transcript
      expect(screen.getByText("keep going")).toBeTruthy(); // optimistic message survives
    } finally { vi.useRealTimers(); }
  });

  it("keeps polling through a transient /state failure and still completes", async () => {
    vi.useFakeTimers();
    try {
      setStudioChat("demo8", { chatId: "chat_8", sessionId: "sess_8", agent: "codex" });
      let stateCalls = 0;
      const fetchMock = vi.fn(async (url: string) => {
        const path = new URL(url, "http://x").pathname;
        if (path.includes("/api/chat/chat_8/state")) {
          stateCalls++;
          if (stateCalls === 2) throw new Error("socket hiccup"); // first poll tick fails
          return { ok: true, json: async () => ({ alive: true, running: stateCalls < 3 }) } as unknown as Response;
        }
        if (path.includes("/api/inspect/session")) {
          const body = { sessionId: "sess_8", agent: "codex", meta: inspectMeta("sess_8"), turns: [] };
          return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
        name: "demo8", html: "<p>x</p>",
        meta: { title: "Demo8", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
      } as never);

      render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo8" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

      await vi.waitFor(() => expect(screen.getByText(/resuming…/i)).toBeTruthy());
      await vi.advanceTimersByTimeAsync(5000); // tick 1 throws → tick 2 completes
      await vi.waitFor(() => expect(screen.queryByText(/resuming…|working…/i)).toBeNull());
    } finally { vi.useRealTimers(); }
  });

  it("stops polling when the panel unmounts (no orphan loop)", async () => {
    vi.useFakeTimers();
    try {
      setStudioChat("demo9", { chatId: "chat_9", sessionId: "sess_9", agent: "codex" });
      const fetchMock = routeFetch({
        "/api/inspect/session": { sessionId: "sess_9", agent: "codex", meta: inspectMeta("sess_9"), turns: [] },
        "/api/chat/chat_9/state": { alive: true, running: true },
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
        name: "demo9", html: "<p>x</p>",
        meta: { title: "Demo9", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
      } as never);

      const { unmount } = render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo9" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

      await vi.waitFor(() => expect(screen.getByText(/resuming…/i)).toBeTruthy());
      await vi.advanceTimersByTimeAsync(1600); // let the loop take at least one tick
      const calls = fetchMock.mock.calls.length;
      unmount();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock.mock.calls.length).toBe(calls); // generation guard: nothing after unmount
    } finally { vi.useRealTimers(); }
  });

  it("admits connection trouble after repeated /state failures instead of claiming work", async () => {
    vi.useFakeTimers();
    try {
      setStudioChat("demo10", { chatId: "chat_10", sessionId: "sess_10", agent: "codex" });
      let stateCalls = 0;
      const fetchMock = vi.fn(async (url: string) => {
        const path = new URL(url, "http://x").pathname;
        if (path.includes("/api/chat/chat_10/state")) {
          stateCalls++;
          if (stateCalls > 1) throw new Error("server unreachable"); // mount succeeds; every poll tick fails
          return { ok: true, json: async () => ({ alive: true, running: true }) } as unknown as Response;
        }
        if (path.includes("/api/inspect/session")) {
          const body = { sessionId: "sess_10", agent: "codex", meta: inspectMeta("sess_10"), turns: [] };
          return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
        name: "demo10", html: "<p>x</p>",
        meta: { title: "Demo10", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
      } as never);

      render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo10" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

      await vi.waitFor(() => expect(screen.getByText(/resuming…/i)).toBeTruthy());
      await vi.advanceTimersByTimeAsync(4 * 1500 + 500); // OFFLINE_TICKS consecutive failures
      await vi.waitFor(() => expect(screen.getByText(/can't reach the agent — retrying…/i)).toBeTruthy());
    } finally { vi.useRealTimers(); }
  });

  it("restores the message to the composer when the server rejects it (already running)", async () => {
    vi.useFakeTimers();
    try {
      setStudioChat("demo11", { chatId: "chat_11", sessionId: "sess_11", agent: "codex" });
      vi.mocked(openStudioStream).mockImplementationOnce(
        (_apiBase: string, _chatId: string, _message: string, h: { onFailed: (e: string) => void }) => {
          h.onFailed("a turn is already running for this chat");
          return () => {};
        });
      const fetchMock = routeFetch({
        "/api/inspect/session": { sessionId: "sess_11", agent: "codex", meta: inspectMeta("sess_11"), turns: [] },
        "/api/chat/chat_11/state": { alive: true, running: false }, // idle at mount; reconcile-poll resolves fast
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
        name: "demo11", html: "<p>x</p>",
        meta: { title: "Demo11", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
      } as never);

      render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo11" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

      await vi.advanceTimersByTimeAsync(0); // flush the mount effect's fetch chain
      const sendBtn = screen.getByRole("button", { name: "Send" });
      fireEvent.change(screen.getByPlaceholderText(/ask the agent/i), { target: { value: "second thought" } });
      fireEvent.click(sendBtn);

      await vi.waitFor(() => expect(screen.getByText("agent is still working — message not sent")).toBeTruthy());
      // { selector: "div" } excludes the composer textarea: React mirrors a controlled
      // textarea's value into its text-node children on update, so a bare queryByText
      // would false-positive on the very restore this test is checking for (see below).
      expect(screen.queryByText("second thought", { selector: "div" })).toBeNull(); // un-appended from the log
      expect(screen.getByDisplayValue("second thought")).toBeTruthy();       // back in the composer
    } finally { vi.useRealTimers(); }
  });

  it("Enter while busy queues the restored composer text — promised for the next turn, never lost", async () => {
    vi.useFakeTimers();
    try {
      // No pre-seeded studioChatStore entry for "demo12" (a fresh miniapp/chat, unlike the other
      // tests): mount finds nothing to restore, so busy starts false and Send is clickable — the
      // "already running" rejection (and the resulting busy lock) comes entirely from this send().
      vi.mocked(openStudioStream).mockImplementationOnce(
        (_apiBase: string, _chatId: string, _message: string, h: { onFailed: (e: string) => void }) => {
          h.onFailed("a turn is already running for this chat");
          return () => {};
        });
      const post = vi.fn();
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/api/chat") && init?.method === "POST") {
          post(init);
          return { ok: true, json: async () => ({ chatId: "chat_12", sessionId: "sess_12" }) } as unknown as Response;
        }
        // Still running if the poll's first tick ever fires (it shouldn't within this test) —
        // keeps busy locked, matching what "already running" means (another window owns the turn).
        if (String(url).includes("/state")) return { ok: true, json: async () => ({ alive: true, running: true }) } as unknown as Response;
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }));
      vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
        name: "demo12", html: "<p>x</p>",
        meta: { title: "Demo12", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
      } as never);

      render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo12" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

      await vi.advanceTimersByTimeAsync(0); // flush the mount effect (no stored chat → no-op)
      const textarea = screen.getByPlaceholderText(/ask the agent/i);
      fireEvent.change(textarea, { target: { value: "second thought" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      await vi.waitFor(() => expect(screen.getByDisplayValue("second thought")).toBeTruthy());
      expect(post).toHaveBeenCalled();

      // Pressing Enter while still busy QUEUES the restored text (2026-07-20 queue design). This
      // supersedes the old no-op protection with a stronger one: the message leaves the composer
      // as a queued chip that fires when the background turn ends — promised, not lost.
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(screen.queryByDisplayValue("second thought")).toBeNull();
      expect(screen.getByText("second thought", { selector: ".studio-queue__text" })).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it("a turn completing via the resume poll fires the queued messages (eng review issue 1)", async () => {
    vi.useFakeTimers();
    try {
      setStudioChat("demo15", { chatId: "chat_15", sessionId: "sess_15", agent: "codex" });
      let stateCalls = 0;
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        const path = new URL(url, "http://x").pathname;
        if (path.includes("/api/chat/chat_15/state")) {
          stateCalls++;
          return { ok: true, json: async () => ({ alive: true, running: stateCalls < 2, sessionId: "sess_15", agent: "codex" }) } as unknown as Response;
        }
        if (path.includes("/api/inspect/session")) {
          return { ok: true, json: async () => ({ sessionId: "sess_15", agent: "codex", meta: inspectMeta("sess_15"), turns: [] }), text: async () => "" } as unknown as Response;
        }
        return { ok: true, json: async () => ({}), text: async () => "{}" } as unknown as Response;
      }));
      vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
        name: "demo15", html: "<p>x</p>",
        meta: { title: "Demo15", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
      } as never);
      // The queued flush's own stream: benign impl (no immediate onFailed) so the assert stays clean.
      vi.mocked(openStudioStream).mockImplementation(() => () => {});

      render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo15" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);
      await vi.advanceTimersByTimeAsync(0);      // mount: resume detects the running background turn

      // Type while the resumed turn is busy — must queue, not drop.
      const textarea = screen.getByPlaceholderText(/ask the agent/i);
      fireEvent.change(textarea, { target: { value: "queued during resume" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      await vi.waitFor(() => expect(screen.getByText("queued during resume")).toBeTruthy()); // chip

      // Next poll tick sees running:false → completion path must FIRE the queue (not leave it held).
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => {
        const calls = vi.mocked(openStudioStream).mock.calls;
        expect(calls.some((c) => c[2] === "queued during resume")).toBe(true);
      });
      // chips cleared (vi.waitFor: the state update happened in a poll-tick callback; the re-render
      // needs a flush under fake timers)
      await vi.waitFor(() => expect(screen.queryByText("queued during resume", { selector: ".studio-queue__text" })).toBeNull());
    } finally { vi.useRealTimers(); }
  });

  it("keeps polling through a non-ok /state response and still completes", async () => {
    vi.useFakeTimers();
    try {
      setStudioChat("demo13", { chatId: "chat_13", sessionId: "sess_13", agent: "codex" });
      let stateCalls = 0;
      const fetchMock = vi.fn(async (url: string) => {
        const path = new URL(url, "http://x").pathname;
        if (path.includes("/api/chat/chat_13/state")) {
          stateCalls++;
          if (stateCalls === 2) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response; // first poll tick: transient 500
          return { ok: true, json: async () => ({ alive: true, running: stateCalls < 3 }) } as unknown as Response;
        }
        if (path.includes("/api/inspect/session")) {
          const body = { sessionId: "sess_13", agent: "codex", meta: inspectMeta("sess_13"), turns: [] };
          return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
        name: "demo13", html: "<p>x</p>",
        meta: { title: "Demo13", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
      } as never);

      render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo13" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

      await vi.waitFor(() => expect(screen.getByText(/resuming…/i)).toBeTruthy());
      await vi.advanceTimersByTimeAsync(1600); // tick 1: 500 — poll must survive it
      expect(screen.getByText(/working…|resuming…/i)).toBeTruthy();
      await vi.advanceTimersByTimeAsync(1600); // tick 2: completes
      await vi.waitFor(() => expect(screen.queryByText(/resuming…|working…/i)).toBeNull());
    } finally { vi.useRealTimers(); }
  });
});
