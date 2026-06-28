import { describe, it, expect, vi, afterEach } from "vitest";
import { openAnalyzeStream, type AnalyzeEvent } from "./analyzeStream.js";

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(type: string, cb: (e: unknown) => void) { (this.listeners[type] ??= []).push(cb); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) }); }
}

afterEach(() => { FakeES.last = null; });

describe("openAnalyzeStream", () => {
  it("passes root + fresh and translates events, closing on done", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const events: AnalyzeEvent[] = [];
    openAnalyzeStream("", "/home/me/proj", true, (e) => events.push(e));
    const es = FakeES.last!;
    expect(es.url).toContain("root=%2Fhome%2Fme%2Fproj");
    expect(es.url).toContain("fresh=1");

    es.emit("phase", { phase: "scanning" });
    es.emit("phase", { phase: "scanned", transcripts: 4, sessions: 2 });
    es.emit("delta", { text: "thinking…" });
    es.emit("done", { cached: false });

    expect(events).toEqual([
      { type: "phase", phase: "scanning", transcripts: undefined, sessions: undefined },
      { type: "phase", phase: "scanned", transcripts: 4, sessions: 2 },
      { type: "delta", text: "thinking…" },
      { type: "done", cached: false, candidates: [] },
    ]);
    expect(es.closed).toBe(true);
  });
});
