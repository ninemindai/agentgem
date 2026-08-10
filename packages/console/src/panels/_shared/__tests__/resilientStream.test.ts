// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/_shared/__tests__/resilientStream.test.ts
//
// The stall watchdog and polling fallback. A buffering proxy looks like a healthy
// EventSource that never delivers — the wrapper must detect the silence (the server
// pings every 15s, so 25s of nothing is proof) and switch to ?poll=1 polling
// without re-delivering what SSE already sent.
import { describe, it, expect, vi, afterEach } from "vitest";
import { openResilientStream, type PollResult } from "../resilientStream.js";

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(type: string, cb: (e: unknown) => void) { (this.listeners[type] ??= []).push(cb); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) }); }
  error() { for (const cb of this.listeners.error ?? []) cb({}); }
}

afterEach(() => { FakeES.last = null; vi.unstubAllGlobals(); vi.useRealTimers(); });

type Cursor = { after: number };
function open(overrides: Partial<Parameters<typeof openResilientStream<Cursor>>[0]> = {}) {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
  const delivered: { event: string; data: unknown }[] = [];
  const polls: Cursor[] = [];
  let pollResult: PollResult<Cursor> = { messages: [], cursor: { after: 0 } };
  const close = openResilientStream<Cursor>({
    streamUrl: "/api/x/stream?file=f",
    events: ["phase", "event", "failed"],
    initialCursor: { after: 0 },
    advance: (c, event, data) => (event === "event" ? { after: (data as { index: number }).index + 1 } : c),
    poll: async (c) => { polls.push(c); return pollResult; },
    onMessage: (event, data) => delivered.push({ event, data }),
    ...overrides,
  });
  return { delivered, polls, close, setPollResult: (r: PollResult<Cursor>) => { pollResult = r; } };
}

describe("openResilientStream", () => {
  it("forwards SSE events and never polls while the stream stays live", async () => {
    const { delivered, polls } = open();
    const es = FakeES.last!;
    es.emit("phase", { phase: "watching" });
    es.emit("event", { index: 0 });
    // pings keep the watchdog fed across a long quiet stretch
    for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(15_000); es.emit("ping", {}); }
    await Promise.resolve();
    expect(delivered.map((d) => d.event)).toEqual(["phase", "event"]);
    expect(polls).toEqual([]);
    expect(es.closed).toBe(false);
  });

  it("downgrades to polling after silence, carrying the SSE-advanced cursor", async () => {
    const { delivered, polls, setPollResult } = open();
    const es = FakeES.last!;
    es.emit("event", { index: 0 });
    es.emit("event", { index: 1 });

    setPollResult({ messages: [{ event: "event", data: { index: 2 } }], cursor: { after: 3 } });
    vi.advanceTimersByTime(25_000); // watchdog fires: no event or ping in the window
    await vi.advanceTimersByTimeAsync(0);

    expect(es.closed).toBe(true);
    expect(polls).toEqual([{ after: 2 }]); // backlog SSE already delivered is not re-fetched
    expect(delivered.map((d) => d.event)).toEqual(["event", "event", "event"]);

    // subsequent polls use the server-returned cursor
    setPollResult({ messages: [], cursor: { after: 3 } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(polls[1]).toEqual({ after: 3 });
  });

  it("treats an EventSource error as a stall, not a terminal failure", async () => {
    const { delivered, polls } = open();
    FakeES.last!.error();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeES.last!.closed).toBe(true);
    expect(polls.length).toBe(1);
    expect(delivered.find((d) => d.event === "failed")).toBeUndefined();
  });

  it("emits failed and stops when polling itself fails", async () => {
    const { delivered } = open({ poll: async () => { throw new Error("down"); } });
    FakeES.last!.error();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual([{ event: "failed", data: { message: "connection lost" } }]);
    // no further poll timer: advancing time delivers nothing new
    await vi.advanceTimersByTimeAsync(10_000);
    expect(delivered.length).toBe(1);
  });

  it("close() during SSE stops the watchdog and never polls", async () => {
    const { polls, close } = open();
    close();
    expect(FakeES.last!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls).toEqual([]);
  });

  it("stops polling when a delivered message closes the stream mid-batch", async () => {
    const seen: { event: string; data: unknown }[] = [];
    const handle = open({
      onMessage: (event, data) => { seen.push({ event, data }); if (event === "failed") handle.close(); },
    });
    handle.setPollResult({
      messages: [{ event: "failed", data: { message: "gone" } }, { event: "event", data: { index: 9 } }],
      cursor: { after: 0 },
    });
    FakeES.last!.error();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([{ event: "failed", data: { message: "gone" } }]); // trailing batch entry dropped
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handle.polls.length).toBe(1); // no second poll after close
  });
});
