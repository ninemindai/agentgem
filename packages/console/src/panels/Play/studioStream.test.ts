import { describe, it, expect, vi, afterEach } from "vitest";
import { openStudioStream } from "./studioStream.js";

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(type: string, cb: (e: unknown) => void) { (this.listeners[type] ??= []).push(cb); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) }); }
  emitRaw(type: string, raw: string) { for (const cb of this.listeners[type] ?? []) cb({ data: raw }); }
}
const handlers = () => ({ onDelta: vi.fn(), onTool: vi.fn(), onDone: vi.fn(), onFailed: vi.fn() });

// POST-then-stream: the message rides POST /api/chat/turn, then the ES attaches by turnId.
const stubTurn = (reply: { ok?: boolean; status?: number; turnId?: string } = {}) => {
  const posts: { url: string; body: string }[] = [];
  vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    posts.push({ url: String(url), body: String(init?.body ?? "") });
    return { ok: reply.ok ?? true, status: reply.status ?? 200, json: async () => ({ turnId: reply.turnId ?? "t9" }) };
  }) as unknown as typeof fetch);
  return posts;
};
afterEach(() => { FakeES.last = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("openStudioStream", () => {
  it("POSTs the message to /api/chat/turn, attaches by turnId, routes frames, closes on done", async () => {
    const posts = stubTurn();
    const h = handlers();
    openStudioStream("http://x", "c1", "hi there", h);
    await vi.waitFor(() => expect(FakeES.last).toBeTruthy());
    expect(posts[0].url).toBe("http://x/api/chat/turn");
    expect(JSON.parse(posts[0].body)).toEqual({ chatId: "c1", message: "hi there" });
    expect(FakeES.last!.url).toContain("turnId=t9");
    expect(FakeES.last!.url).not.toContain("message=");   // the message never rides the query string
    FakeES.last!.emit("delta", { text: "yo" });
    FakeES.last!.emit("done", { result: { text: "yo", toolCalls: [], stopReason: "cancelled" } });
    expect(h.onDelta).toHaveBeenCalledWith("yo");
    expect(h.onDone).toHaveBeenCalledWith({ text: "yo", toolCalls: [], stopReason: "cancelled" });
    expect(FakeES.last!.closed).toBe(true);
  });

  it("an HTTP error from the turn POST fails without opening a stream", async () => {
    stubTurn({ ok: false, status: 500 });
    const h = handlers();
    openStudioStream("http://x", "c1", "hi", h);
    await vi.waitFor(() => expect(h.onFailed).toHaveBeenCalledWith("turn start failed (500)"));
    expect(FakeES.last).toBeNull();
  });

  it("closing while the turn POST is in flight never opens a zombie stream", async () => {
    let release: (() => void) | null = null;
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    vi.stubGlobal("fetch", vi.fn(() => new Promise((r) => {
      release = () => r({ ok: true, json: async () => ({ turnId: "t9" }) });
    })) as unknown as typeof fetch);
    const h = handlers();
    const close = openStudioStream("http://x", "c1", "hi", h);
    close();                                   // torn down before the POST resolves
    release!();
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeES.last).toBeNull();            // no EventSource ever constructed
  });

  it("a malformed done frame closes the stream and fails instead of hanging the capability", async () => {
    stubTurn();
    const h = handlers();
    openStudioStream("http://x", "c2", "hi", h);
    await vi.waitFor(() => expect(FakeES.last).toBeTruthy());
    expect(() => FakeES.last!.emitRaw("done", "{ not json")).not.toThrow();
    expect(FakeES.last!.closed).toBe(true);   // stream closed → invoke-agent capability unlocks
    expect(h.onFailed).toHaveBeenCalled();     // a terminal handler still fires
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it("a malformed delta frame is skipped without throwing or killing the stream", async () => {
    stubTurn();
    const h = handlers();
    openStudioStream("http://x", "c3", "hi", h);
    await vi.waitFor(() => expect(FakeES.last).toBeTruthy());
    expect(() => FakeES.last!.emitRaw("delta", "garbage")).not.toThrow();
    expect(h.onDelta).not.toHaveBeenCalled();
    expect(FakeES.last!.closed).toBe(false);   // stream stays alive
    FakeES.last!.emit("done", { result: { text: "", toolCalls: [] } });
    expect(h.onDone).toHaveBeenCalled();        // a later valid frame still completes
  });
});
