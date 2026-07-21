// packages/console/src/panels/Chat/Chat.queue.test.tsx
// Type-while-busy queue + turn Interrupt for the Chat tab (spec:
// 2026-07-20-chat-queue-interrupt-design.md). Same contract as Studio.queue.test.tsx; harness
// mirrors Chat.launcher.test.tsx (stubbed fetch) plus a FakeES for the real openChatStream.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { Chat } from "./index.js";

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

const res = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const setup = async (intercept?: (url: string, init?: RequestInit) => unknown) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const hit = intercept?.(u, init);
    if (hit) return hit;
    if (u.endsWith("/api/chat/turn") && init?.method === "POST") return res({ turnId: "t1" });
    if (u.endsWith("/api/agents")) return res({ agents: [{ id: "claude-code", name: "Claude Code", available: true }] });
    if (u.endsWith("/api/testbed/recents")) return res({ recents: [] });
    if (u.endsWith("/api/testbed/projects")) return res({ projects: [] });
    if (u.endsWith("/api/chat")) return res({ chatId: "c1" });
    return res({});
  }));
  vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
  render(<Chat apiBase="" />);
  const box = await screen.findByRole("textbox");
  fireEvent.change(box, { target: { value: "start the turn" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(FakeES.last).toBeTruthy());
  return { calls, box: box as HTMLInputElement };
};
// POST-then-stream: the coalesced message rides the /api/chat/turn POST body.
const lastTurnMessage = (calls: { url: string; init?: RequestInit }[]) =>
  JSON.parse(String(calls.filter((c) => c.url.endsWith("/api/chat/turn") && c.init?.method === "POST").at(-1)?.init?.body ?? "{}")).message as string;
const typeEnter = (box: HTMLInputElement, text: string) => {
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
};

describe("Chat tab queue + interrupt", () => {
  it("typing while busy queues a chip, clears the box, opens no second stream", async () => {
    const { box } = await setup();
    const streams = FakeES.count;
    typeEnter(box, "also this");
    expect(await screen.findByText("also this")).toBeTruthy();
    expect(box.value).toBe("");
    expect(FakeES.count).toBe(streams);
  });

  it("a queued chip is removable before it fires", async () => {
    const { box } = await setup();
    typeEnter(box, "oops");
    fireEvent.click(await screen.findByLabelText("remove queued message 1"));
    expect(screen.queryByText("oops")).toBeNull();
    FakeES.last!.emit("done", { result: { text: "ok", toolCalls: [] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeES.count).toBe(1);
  });

  it("done coalesces the queue into ONE next turn on the SAME chat session", async () => {
    const { calls, box } = await setup();
    typeEnter(box, "a");
    typeEnter(box, "b");
    FakeES.last!.emit("done", { result: { text: "ok", toolCalls: [] } });
    await waitFor(() => expect(FakeES.count).toBe(2));
    expect(lastTurnMessage(calls)).toBe("a\nb");
    expect(calls.filter((c) => c.url.endsWith("/api/chat") && c.init?.method === "POST").length).toBe(1);
  });

  it("failed holds the queue; 'Send queued' fires it explicitly", async () => {
    const { calls, box } = await setup();
    typeEnter(box, "held");
    FakeES.last!.emit("failed", { error: "boom" });
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeES.count).toBe(1);
    fireEvent.click(await screen.findByText("Send queued"));
    await waitFor(() => expect(FakeES.count).toBe(2));
    expect(lastTurnMessage(calls)).toBe("held");
  });

  it("Interrupt cancels the turn; the cancelled done marks the transcript and fires the queue", async () => {
    const { calls, box } = await setup((url, init) => {
      if (url.includes("/cancel") && init?.method === "POST") return res({ cancelled: true });
    });
    typeEnter(box, "do this instead");
    fireEvent.click(screen.getByText("Interrupt"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/chat/c1/cancel") && c.init?.method === "POST")).toBe(true));
    FakeES.last!.emit("done", { result: { text: "partial", toolCalls: [], stopReason: "cancelled" } });
    await waitFor(() => expect(screen.getByText(/interrupted/)).toBeTruthy());
    await waitFor(() => expect(FakeES.count).toBe(2));
    expect(lastTurnMessage(calls)).toBe("do this instead");
  });

  // Eng review issue 8: fetch resolves on HTTP errors — the failure message must still surface.
  it("Interrupt surfaces an error when the cancel route returns an HTTP error", async () => {
    await setup((url, init) => {
      if (url.includes("/cancel") && init?.method === "POST")
        return { ok: false, status: 500, json: async () => ({}), text: async () => "{}" } as unknown as Response;
    });
    fireEvent.click(screen.getByText("Interrupt"));
    await waitFor(() => expect(screen.getByText(/interrupt failed/)).toBeTruthy());
  });

  // Eng review issue 3: a cancelled:false reply gets an honest line, not silence.
  it("Interrupt surfaces a message when there was nothing to cancel", async () => {
    await setup((url, init) => {
      if (url.includes("/cancel") && init?.method === "POST") return res({ cancelled: false });
    });
    fireEvent.click(screen.getByText("Interrupt"));
    await waitFor(() => expect(screen.getByText(/nothing to interrupt/)).toBeTruthy());
  });

  // Eng review issue 7: the guaranteed recovery — kill the session even mid-turn; issue 9: the
  // queue dies with the session it was written against.
  it("End session kills the chat mid-turn and clears the queue", async () => {
    const { calls, box } = await setup();
    typeEnter(box, "orphan me");
    await screen.findByText("orphan me");
    fireEvent.click(screen.getByText("End session"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/chat/c1") && c.init?.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.queryByText("orphan me")).toBeNull());   // chips cleared
    expect(screen.getByText(/session ended/)).toBeTruthy();
    const streams = FakeES.count;
    FakeES.last!.emit("done", { result: { text: "late", toolCalls: [] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeES.count).toBe(streams);                                        // nothing fired
  });
});
