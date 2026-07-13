import { describe, it, expect } from "vitest";
import { createClient, type Client } from "@agentback/client";
import { openInsightsStream, type InsightsEvent } from "./insightsStream.js";

const REPORT = {
  totals: { sessions: 2, mostly: 1, partially: 1, not: 0 },
  outcomes_summary: "2 session(s): 1 mostly achieved, 1 partial, 0 not achieved.",
  narrative: "You ship end-to-end and verify as you go.",
  by_model: [{ model: "claude-opus-4-8", mostly: 1, partially: 1, not: 0, total: 2 }],
  friction: [{ sessionId: "b", detail: "interrupted" }],
  publish_candidates: [{ sessionId: "a", goal: "ship auth", why: "Succeeded: merged" }],
};

// A client whose fetch replays `items` as a text/event-stream body — the wire
// the server's streamOf route produces (anonymous `data:` frames). Lets us drive
// the real route.stream() consumer (URL building, SSE parse, per-event validation)
// without a live server.
function sseClient(items: unknown[], onUrl?: (url: string) => void): Client {
  const fetch = (async (url: string | URL | Request) => {
    onUrl?.(String(url));
    const body = items.map((i) => `data: ${JSON.stringify(i)}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return createClient({ baseURL: "http://console.test", fetch });
}

// openInsightsStream is fire-and-forget; resolve once a terminal event arrives.
function run(client: Client, root: string, opts?: { fresh?: boolean; cacheOnly?: boolean }): Promise<InsightsEvent[]> {
  return new Promise((resolve) => {
    const events: InsightsEvent[] = [];
    openInsightsStream(client, root, (e) => {
      events.push(e);
      if (e.type === "done" || e.type === "failed") resolve(events);
    }, opts);
  });
}

describe("openInsightsStream", () => {
  it("forwards phase/delta/done, passes the report through, and carries cached", async () => {
    const events = await run(sseClient([
      { type: "phase", phase: "scanning" },
      { type: "phase", phase: "scanned", transcripts: 4, sessions: 2 },
      { type: "delta", text: "judging…" },
      { type: "done", report: REPORT, degraded: false, cached: true, scanned: 1467, updatedAt: 123 },
    ]), "/home/me/proj");

    expect(events.map((e) => e.type)).toEqual(["phase", "phase", "delta", "done"]);
    expect(events[1]).toMatchObject({ type: "phase", phase: "scanned", transcripts: 4, sessions: 2 });
    const done = events[3];
    expect(done).toMatchObject({ type: "done", degraded: false, cached: true, scanned: 1467, updatedAt: 123 });
    if (done.type === "done") expect(done.report).toEqual(REPORT);
  });

  it("puts the project root, fresh=1, and cacheOnly on the request", async () => {
    let seen = "";
    await run(sseClient([{ type: "done", report: REPORT, degraded: false, cached: false, updatedAt: null }], (u) => { seen = u; }), "/home/me/proj", { fresh: true, cacheOnly: true });
    expect(seen).toContain("root=%2Fhome%2Fme%2Fproj");
    expect(seen).toContain("fresh=1");
    expect(seen).toContain("cacheOnly=1");
  });

  it("forwards a failed event", async () => {
    const events = await run(sseClient([{ type: "failed", message: "boom" }]), "/p");
    expect(events).toEqual([{ type: "failed", message: "boom" }]);
  });
});
