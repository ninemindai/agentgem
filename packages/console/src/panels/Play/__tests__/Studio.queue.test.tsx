// packages/console/src/panels/Play/__tests__/Studio.queue.test.tsx
// Type-while-busy queue + turn Interrupt (spec: 2026-07-20-chat-queue-interrupt-design.md).
// Harness mirrors Studio.test.tsx: FakeES for the SSE stream, stubbed fetch for raw endpoints.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Studio } from "../Studio.js";
import { playMiniappRoute, playUploadsRoute } from "../../../api/routes.js";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";

class FakeES {
  static last: FakeES | null = null;
  static count = 0;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor(public url: string) { FakeES.last = this; FakeES.count++; }
  addEventListener(t: string, cb: (e: unknown) => void) { (this.listeners[t] ??= []).push(cb); }
  close() {}
  emit(t: string, data: unknown) { for (const cb of this.listeners[t] ?? []) cb({ data: JSON.stringify(data) }); }
}
afterEach(() => { cleanup(); FakeES.last = null; FakeES.count = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const app = {
  name: "g1", html: "<!doctype html><body><canvas></canvas></body>",
  meta: { title: "G1", genre: "replay", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
} as const;

const setup = async (intercept?: (url: string, init?: RequestInit) => unknown) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const hit = intercept?.(String(url), init);
    if (hit) return hit;
    if (String(url).includes("/api/chat/turn") && init?.method === "POST")
      return { ok: true, json: async () => ({ turnId: "t1" }) };
    if (String(url).includes("/api/chat") && init?.method === "POST" && !String(url).includes("/cancel"))
      return { ok: true, json: async () => ({ chatId: "c1" }) };
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch);
  vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
  vi.spyOn(playMiniappRoute, "call").mockResolvedValue(app as never);
  render(<IdentityProvider apiBase=""><Studio apiBase="" name="g1"
    agents={[{ id: "codex", name: "Codex", available: true }]} agentId="codex"
    onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);
  // start a turn so the composer is busy
  fireEvent.change(screen.getByPlaceholderText(/build\/edit/i), { target: { value: "make it blue" } });
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(FakeES.last).toBeTruthy());
  return { calls };
};
// POST-then-stream: the coalesced message rides the /api/chat/turn POST body.
const lastTurnMessage = (calls: { url: string; init?: RequestInit }[]) =>
  JSON.parse(String(calls.filter((c) => c.url.endsWith("/api/chat/turn") && c.init?.method === "POST").at(-1)?.init?.body ?? "{}")).message as string;
const typeEnter = (text: string) => {
  const box = screen.getByPlaceholderText(/build\/edit/i);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
  return box as HTMLTextAreaElement;
};

describe("Studio queue + interrupt", () => {
  it("typing while busy queues a chip, clears the box, opens no second stream", async () => {
    await setup();
    const streams = FakeES.count;
    const box = typeEnter("also blue");
    expect(await screen.findByText("also blue")).toBeTruthy();   // chip rendered
    expect(box.value).toBe("");
    expect(FakeES.count).toBe(streams);                          // nothing sent
  });

  it("a queued chip is removable before it fires", async () => {
    await setup();
    typeEnter("oops");
    fireEvent.click(await screen.findByLabelText("remove queued message 1"));
    expect(screen.queryByText("oops")).toBeNull();
    FakeES.last!.emit("done", { result: { text: "ok", toolCalls: [] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeES.count).toBe(1);                                // removed chip never sent
  });

  it("done coalesces the queue into ONE next turn on the SAME chat session", async () => {
    const { calls } = await setup();
    typeEnter("a");
    typeEnter("b");
    FakeES.last!.emit("done", { result: { text: "ok", toolCalls: [] } });
    await waitFor(() => expect(FakeES.count).toBe(2));           // exactly one follow-up stream
    expect(lastTurnMessage(calls)).toBe("a\nb");
    expect(screen.queryByText("a")).toBeNull();                  // chips cleared
    // The queued flush reuses the live session — a second POST /api/chat would fork a new one.
    expect(calls.filter((c) => c.url.endsWith("/api/chat") && c.init?.method === "POST").length).toBe(1);
  });

  it("failed holds the queue; 'Send queued' fires it explicitly", async () => {
    const { calls } = await setup();
    typeEnter("held");
    FakeES.last!.emit("failed", { error: "boom" });
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeES.count).toBe(1);                                // no auto-fire into a broken turn
    fireEvent.click(await screen.findByText("Send queued"));
    await waitFor(() => expect(FakeES.count).toBe(2));
    expect(lastTurnMessage(calls)).toBe("held");
  });

  it("Interrupt cancels the turn; the cancelled done marks the transcript and fires the queue", async () => {
    const { calls } = await setup((url, init) => {
      if (url.includes("/cancel") && init?.method === "POST") return { ok: true, json: async () => ({ cancelled: true }) };
    });
    typeEnter("do this instead");
    fireEvent.click(screen.getByText("Interrupt"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/chat/c1/cancel") && c.init?.method === "POST")).toBe(true));
    FakeES.last!.emit("done", { result: { text: "partial", toolCalls: [], stopReason: "cancelled" } });
    await waitFor(() => expect(screen.getByText(/interrupted/)).toBeTruthy());
    await waitFor(() => expect(FakeES.count).toBe(2));           // redirect: queue fired
    expect(lastTurnMessage(calls)).toBe("do this instead");
  });

  // Eng review issue 8: fetch RESOLVES on HTTP errors — the fallback must run on ok:false, not
  // only on network rejection.
  it("Interrupt falls back to session-kill when the cancel route returns an HTTP error", async () => {
    const { calls } = await setup((url, init) => {
      if (url.includes("/cancel") && init?.method === "POST") return { ok: false, status: 500, json: async () => ({}) };
    });
    fireEvent.click(screen.getByText("Interrupt"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/chat/c1") && c.init?.method === "DELETE")).toBe(true));
  });

  // Eng review issue 3: a cancelled:false reply (turn just ended, or no cancel support) must say so.
  it("Interrupt surfaces a status line when there was nothing to cancel", async () => {
    await setup((url, init) => {
      if (url.includes("/cancel") && init?.method === "POST") return { ok: true, json: async () => ({ cancelled: false }) };
    });
    fireEvent.click(screen.getByText("Interrupt"));
    await waitFor(() => expect(screen.getByText(/nothing to interrupt/)).toBeTruthy());
  });

  it("double-clicking Interrupt is a harmless no-op (two POSTs, one stream, no crash)", async () => {
    const { calls } = await setup((url, init) => {
      if (url.includes("/cancel") && init?.method === "POST") return { ok: true, json: async () => ({ cancelled: true }) };
    });
    fireEvent.click(screen.getByText("Interrupt"));
    fireEvent.click(screen.getByText("Interrupt"));
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/cancel")).length).toBe(2));
    expect(FakeES.count).toBe(1);
    FakeES.last!.emit("done", { result: { text: "p", toolCalls: [], stopReason: "cancelled" } });
    await waitFor(() => expect(screen.getByText(/interrupted/)).toBeTruthy());
  });

  // Eng review issue 9: queued messages were written against this session — Stop kills both.
  it("session-kill Stop clears the queue; a late done fires nothing", async () => {
    const { calls } = await setup();
    typeEnter("orphan me");
    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/chat/c1") && c.init?.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.queryByText("orphan me")).toBeNull());  // chips cleared
    const streams = FakeES.count;
    FakeES.last!.emit("done", { result: { text: "late", toolCalls: [] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeES.count).toBe(streams);                                        // nothing fired
  });

  // Uploads stay send-time-only (documented v1): files staged mid-turn do NOT join the queued
  // flush — they keep their chips and attach to the next manual send.
  it("files staged while busy do not join the queued flush", async () => {
    const uploadSpy = vi.spyOn(playUploadsRoute, "call").mockResolvedValue({ files: [], ship: 0, ref: 0 } as never);
    const { calls } = await setup();
    const fileInput = await screen.findByTestId("uploads-input");
    fireEvent.change(fileInput, { target: { files: [new File(["x"], "logo.png", { type: "image/png" })] } });
    await screen.findByTestId("role-logo.png");                                // staged chip present
    typeEnter("queued text");
    FakeES.last!.emit("done", { result: { text: "ok", toolCalls: [] } });
    await waitFor(() => expect(FakeES.count).toBe(2));
    expect(lastTurnMessage(calls)).toBe("queued text"); // no preamble
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("role-logo.png")).toBeTruthy();                  // still staged for next send
  });
});
