import { describe, it, expect, vi, afterEach } from "vitest";
import { openScorecardStream, type ScorecardStreamEvent } from "../scorecardStream.js";

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

describe("openScorecardStream", () => {
  it("builds the URL without query params when no opts given", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const events: ScorecardStreamEvent[] = [];
    openScorecardStream("http://localhost:3000", (e) => events.push(e));
    expect(FakeES.last!.url).toBe("http://localhost:3000/api/scorecard/stream");
  });

  it("appends fresh=1 when opts.fresh is true", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    openScorecardStream("", () => {}, { fresh: true });
    expect(FakeES.last!.url).toContain("fresh=1");
  });

  it("translates start/progress/done events and closes on done", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const events: ScorecardStreamEvent[] = [];
    openScorecardStream("", (e) => events.push(e));
    const es = FakeES.last!;

    es.emit("start", { total: 5 });
    es.emit("progress", { done: 2, total: 5, label: "proj-a", partial: { breadth: 7, battleTested: 3, portable: 1 } });
    es.emit("done", { scorecard: { breadth: 10, battleTested: 5, portable: 3, gaps: [], projects: [], degraded: false }, cached: true });

    expect(events[0]).toEqual({ type: "start", total: 5 });
    expect(events[1]).toEqual({ type: "progress", done: 2, total: 5, label: "proj-a", partial: { breadth: 7, battleTested: 3, portable: 1 } });
    expect(events[2]).toMatchObject({ type: "done", cached: true });
    expect(es.closed).toBe(true);
  });

  it("emits failed and closes on failed event", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const events: ScorecardStreamEvent[] = [];
    openScorecardStream("", (e) => events.push(e));
    const es = FakeES.last!;

    es.emit("failed", { message: "scan exploded" });

    expect(events).toEqual([{ type: "failed", message: "scan exploded" }]);
    expect(es.closed).toBe(true);
  });

  it("emits failed on EventSource error event", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const events: ScorecardStreamEvent[] = [];
    openScorecardStream("", (e) => events.push(e));
    const es = FakeES.last!;

    for (const cb of es.listeners["error"] ?? []) cb({});

    expect(events).toEqual([{ type: "failed", message: "stream connection error" }]);
  });

  it("close function returned by openScorecardStream closes the EventSource", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const close = openScorecardStream("", () => {});
    expect(FakeES.last!.closed).toBe(false);
    close();
    expect(FakeES.last!.closed).toBe(true);
  });
});
