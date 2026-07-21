import { describe, it, expect, vi, afterEach } from "vitest";
import { openChatStream } from "../chatStream.js";

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(type: string, cb: (e: unknown) => void) { (this.listeners[type] ??= []).push(cb); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) {
    for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) });
  }
}

// POST-then-stream: openChatStream first POSTs /api/chat/turn, then attaches by turnId.
const stubTurn = () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ turnId: "t1" }) })) as unknown as typeof fetch);
};
const openAndWait = async (chatId: string, message: string, h: Parameters<typeof openChatStream>[2]) => {
  const close = openChatStream(chatId, message, h);
  await vi.waitFor(() => { if (!FakeES.last) throw new Error("stream not open yet"); });
  return close;
};
afterEach(() => { FakeES.last = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("openChatStream", () => {
  it("routes named events to handlers and can unsubscribe", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    stubTurn();
    const onDelta = vi.fn();
    const onDone = vi.fn();
    const stop = await openAndWait("chat_1", "hi", {
      onDelta,
      onTool: vi.fn(),
      onDone,
      onFailed: vi.fn(),
    });

    FakeES.last!.emit("delta", { type: "delta", text: "yo" });
    FakeES.last!.emit("done", { type: "done", result: { text: "yo", toolCalls: [] } });

    expect(onDelta).toHaveBeenCalledWith("yo");
    expect(onDone).toHaveBeenCalledWith({ text: "yo", toolCalls: [] });
    expect(FakeES.last!.closed).toBe(true);

    stop();
    // already closed, second close is a no-op on a real ES — FakeES.closed stays true
    expect(FakeES.last!.closed).toBe(true);
  });

  it("routes tool events to onTool handler", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    stubTurn();
    const onTool = vi.fn();
    await openAndWait("chat_2", "hello", {
      onDelta: vi.fn(),
      onTool,
      onDone: vi.fn(),
      onFailed: vi.fn(),
    });

    FakeES.last!.emit("tool", { tool: { toolCallId: "t1", title: "Read file", status: "running" } });
    expect(onTool).toHaveBeenCalledWith({ toolCallId: "t1", title: "Read file", status: "running" });
  });

  it("routes failed events and closes", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    stubTurn();
    const onFailed = vi.fn();
    await openAndWait("chat_3", "oops", {
      onDelta: vi.fn(),
      onTool: vi.fn(),
      onDone: vi.fn(),
      onFailed,
    });

    FakeES.last!.emit("failed", { error: "agent error" });
    expect(onFailed).toHaveBeenCalledWith("agent error");
    expect(FakeES.last!.closed).toBe(true);
  });

  it("unsubscribe closes the EventSource", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    stubTurn();
    const stop = await openAndWait("chat_4", "bye", {
      onDelta: vi.fn(),
      onTool: vi.fn(),
      onDone: vi.fn(),
      onFailed: vi.fn(),
    });
    expect(FakeES.last!.closed).toBe(false);
    stop();
    expect(FakeES.last!.closed).toBe(true);
  });

  it("error event calls onFailed and closes the EventSource", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    stubTurn();
    const onFailed = vi.fn();
    await openAndWait("chat_5", "error-test", {
      onDelta: vi.fn(),
      onTool: vi.fn(),
      onDone: vi.fn(),
      onFailed,
    });

    FakeES.last!.emit("error", {});
    expect(onFailed).toHaveBeenCalledWith("connection lost");
    expect(FakeES.last!.closed).toBe(true);
  });
});
