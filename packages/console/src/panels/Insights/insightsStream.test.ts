import { describe, it, expect, vi, afterEach } from "vitest";
import { openInsightsStream, type InsightsEvent } from "./insightsStream.js";

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

const REPORT = {
  totals: { sessions: 2, mostly: 1, partially: 1, not: 0 },
  outcomes_summary: "2 session(s): 1 mostly achieved, 1 partial, 0 not achieved.",
  narrative: "You ship end-to-end and verify as you go.",
  by_model: [{ model: "claude-opus-4-8", mostly: 1, partially: 1, not: 0, total: 2 }],
  friction: [{ sessionId: "b", detail: "interrupted" }],
  publish_candidates: [{ sessionId: "a", goal: "ship auth", why: "Succeeded: merged" }],
};

describe("openInsightsStream", () => {
  it("passes root and translates events, closing on done", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const events: InsightsEvent[] = [];
    openInsightsStream("", "/home/me/proj", (e) => events.push(e));
    const es = FakeES.last!;
    expect(es.url).toContain("root=%2Fhome%2Fme%2Fproj");

    es.emit("phase", { phase: "scanning" });
    es.emit("phase", { phase: "scanned", transcripts: 4, sessions: 2 });
    es.emit("delta", { text: "judging…" });
    es.emit("done", { report: REPORT, degraded: false });

    expect(events).toEqual([
      { type: "phase", phase: "scanning", transcripts: undefined, sessions: undefined },
      { type: "phase", phase: "scanned", transcripts: 4, sessions: 2 },
      { type: "delta", text: "judging…" },
      { type: "done", report: REPORT, degraded: false, scanned: undefined, updatedAt: null },
    ]);
    expect(es.closed).toBe(true);
  });

  it("surfaces how many sessions were scanned (for the judged-vs-scanned hint)", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    let done: InsightsEvent | undefined;
    openInsightsStream("", "/p", (e) => { if (e.type === "done") done = e; });
    FakeES.last!.emit("done", { report: REPORT, degraded: false, signalSummary: { sessionsScanned: 1467 } });
    expect(done).toMatchObject({ type: "done", scanned: 1467 });
  });

  it("adds fresh=1 to bypass the cache when requested", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    openInsightsStream("", "/p", () => {}, true);
    expect(FakeES.last!.url).toContain("fresh=1");
  });

  it("translates failed and closes", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const events: InsightsEvent[] = [];
    openInsightsStream("", "/p", (e) => events.push(e));
    const es = FakeES.last!;
    es.emit("failed", { message: "boom" });
    expect(events).toEqual([{ type: "failed", message: "boom" }]);
    expect(es.closed).toBe(true);
  });
});
