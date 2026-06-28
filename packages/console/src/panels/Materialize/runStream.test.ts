import { describe, it, expect, vi, afterEach } from "vitest";
import { openRunStream, type RunEvent } from "./runStream.js";

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  closed = false;
  url: string;
  constructor(url: string) { this.url = url; FakeES.last = this; }
  addEventListener(type: string, cb: (e: unknown) => void) { (this.listeners[type] ??= []).push(cb); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) {
    for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) });
  }
}

afterEach(() => { FakeES.last = null; });

describe("openRunStream", () => {
  it("translates named SSE events and closes on done", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const events: RunEvent[] = [];
    const close = openRunStream("", "run-1", "do the thing", (e) => events.push(e));
    const es = FakeES.last!;
    expect(es.url).toContain("runId=run-1");
    expect(es.url).toContain("task=do+the+thing");

    es.emit("phase", { phase: "running", agent: "claude" });
    es.emit("tool", { name: "read_file" });
    es.emit("delta", { text: "hello " });
    es.emit("delta", { text: "world" });
    es.emit("done", {});

    expect(events).toEqual([
      { type: "phase", phase: "running", agent: "claude" },
      { type: "tool", label: "read_file" },
      { type: "delta", text: "hello " },
      { type: "delta", text: "world" },
      { type: "done" },
    ]);
    expect(es.closed).toBe(true);
    close();
  });

  it("reports failed events", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const events: RunEvent[] = [];
    openRunStream("", "r", "t", (e) => events.push(e));
    FakeES.last!.emit("failed", { message: "boom" });
    expect(events).toEqual([{ type: "failed", message: "boom" }]);
    expect(FakeES.last!.closed).toBe(true);
  });
});
