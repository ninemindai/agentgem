import { describe, it, expect, vi, afterEach } from "vitest";
import { openWatchStream, fetchSessions, type WatchEvent } from "../watchStream.js";

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(type: string, cb: (e: unknown) => void) { (this.listeners[type] ??= []).push(cb); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) }); }
}

afterEach(() => { FakeES.last = null; vi.unstubAllGlobals(); });

const ART = { index: 0, path: "/w/i.html", name: "i.html", tool: "Write", version: 1, tsMs: 1, truncated: false, html: "<h1>hi</h1>" };

describe("openWatchStream", () => {
  it("pins the file query param and translates named events", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const events: WatchEvent[] = [];
    openWatchStream("", "/home/me/.claude/projects/p/s.jsonl", (e) => events.push(e));
    const es = FakeES.last!;
    expect(es.url).toContain("file=%2Fhome%2Fme%2F.claude%2Fprojects%2Fp%2Fs.jsonl");

    es.emit("phase", { phase: "watching" });
    es.emit("artifact", ART);
    expect(events).toEqual([
      { type: "phase", phase: "watching" },
      { type: "artifact", artifact: ART },
    ]);
  });

  it("closes the stream and reports failure on a failed event", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    let failed: WatchEvent | undefined;
    openWatchStream("", "/x.jsonl", (e) => { if (e.type === "failed") failed = e; });
    FakeES.last!.emit("failed", { message: "out-of-scope" });
    expect(failed).toEqual({ type: "failed", message: "out-of-scope" });
    expect(FakeES.last!.closed).toBe(true);
  });
});

describe("fetchSessions", () => {
  it("returns the sessions array from the endpoint", async () => {
    const sessions = [{ id: "s", file: "/f.jsonl", agent: "claude", project: "p", model: null, msgs: 3, startMs: 0, endMs: 1, ageMs: 5 }];
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ sessions }) })) as unknown as typeof fetch);
    expect(await fetchSessions("")).toEqual(sessions);
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch);
    await expect(fetchSessions("")).rejects.toThrow("500");
  });
});
