import { describe, it, expect } from "vitest";
import { createClient, type Client } from "@agentback/client";
import { openScorecardStream, type ScorecardStreamEvent } from "../scorecardStream.js";

// A client whose fetch replays `items` as a text/event-stream body and records the
// requested URL — drives the real route.stream() consumer (URL build + SSE parse).
function sseClient(items: unknown[], onUrl?: (url: string) => void): Client {
  const fetch = (async (url: string | URL | Request) => {
    onUrl?.(String(url));
    const body = items.map((i) => `data: ${JSON.stringify(i)}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return createClient({ baseURL: "http://console.test", fetch });
}

function run(client: Client, opts?: { refresh?: boolean; projects?: string[] }): Promise<ScorecardStreamEvent[]> {
  return new Promise((resolve) => {
    const events: ScorecardStreamEvent[] = [];
    openScorecardStream(client, (e) => {
      events.push(e);
      if (e.type === "done" || e.type === "failed") resolve(events);
    }, opts);
  });
}
const DONE = { type: "done", scorecard: { breadth: 1 }, cached: false, updatedAt: 5 };

describe("openScorecardStream", () => {
  it("requests the scan with no query params when no opts given", async () => {
    let seen = "";
    await run(sseClient([DONE], (u) => { seen = u; }));
    expect(seen).toContain("/api/scorecard/stream");
    expect(seen).not.toContain("refresh");
    expect(seen).not.toContain("projects");
  });

  it("appends refresh=true when opts.refresh is true", async () => {
    let seen = "";
    await run(sseClient([DONE], (u) => { seen = u; }), { refresh: true });
    expect(seen).toContain("refresh=true");
  });

  it("encodes a scoped project list into the query", async () => {
    let seen = "";
    await run(sseClient([DONE], (u) => { seen = u; }), { projects: ["/a", "/b"] });
    expect(seen).toContain(`projects=${encodeURIComponent(JSON.stringify(["/a", "/b"]))}`);
  });

  it("translates stale/start/progress/done events (scorecard passed through)", async () => {
    const events = await run(sseClient([
      { type: "stale", scorecard: { breadth: 5 }, updatedAt: 9 },
      { type: "start", total: 2 },
      { type: "progress", done: 1, total: 2, label: "a", partial: { breadth: 1, battleTested: 0, portable: 0 } },
      { type: "done", scorecard: { breadth: 2 }, cached: false, updatedAt: 10 },
    ]));

    expect(events.map((e) => e.type)).toEqual(["stale", "start", "progress", "done"]);
    expect(events[0]).toMatchObject({ type: "stale", scorecard: { breadth: 5 }, updatedAt: 9 });
    expect(events[2]).toMatchObject({ type: "progress", done: 1, total: 2, label: "a", partial: { breadth: 1 } });
    expect(events[3]).toMatchObject({ type: "done", cached: false, updatedAt: 10, scorecard: { breadth: 2 } });
  });

  it("emits a failed event", async () => {
    const events = await run(sseClient([{ type: "failed", message: "scan exploded" }]));
    expect(events).toEqual([{ type: "failed", message: "scan exploded" }]);
  });
});
