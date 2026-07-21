import { describe, it, expect, vi } from "vitest";
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

describe("openStudioStream", () => {
  it("routes valid frames and closes on done", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const h = handlers();
    openStudioStream("http://x", "c1", "hi", h);
    FakeES.last!.emit("delta", { text: "yo" });
    FakeES.last!.emit("done", { result: { text: "yo", toolCalls: [], stopReason: "cancelled" } });
    expect(h.onDelta).toHaveBeenCalledWith("yo");
    expect(h.onDone).toHaveBeenCalledWith({ text: "yo", toolCalls: [], stopReason: "cancelled" });
    expect(FakeES.last!.closed).toBe(true);
  });

  it("a malformed done frame closes the stream and fails instead of hanging the capability", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const h = handlers();
    openStudioStream("http://x", "c2", "hi", h);
    expect(() => FakeES.last!.emitRaw("done", "{ not json")).not.toThrow();
    expect(FakeES.last!.closed).toBe(true);   // stream closed → invoke-agent capability unlocks
    expect(h.onFailed).toHaveBeenCalled();     // a terminal handler still fires
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it("a malformed delta frame is skipped without throwing or killing the stream", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const h = handlers();
    openStudioStream("http://x", "c3", "hi", h);
    expect(() => FakeES.last!.emitRaw("delta", "garbage")).not.toThrow();
    expect(h.onDelta).not.toHaveBeenCalled();
    expect(FakeES.last!.closed).toBe(false);   // stream stays alive
    FakeES.last!.emit("done", { result: { text: "", toolCalls: [] } });
    expect(h.onDone).toHaveBeenCalled();        // a later valid frame still completes
  });
});
