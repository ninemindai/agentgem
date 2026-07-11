// packages/console/src/panels/Play/__tests__/Studio.resume.test.tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { Studio } from "../Studio.js";
import { setStudioChat, getStudioChat } from "../studioChatStore.js";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";
import { playMiniappRoute } from "../../../api/routes.js";

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
});
