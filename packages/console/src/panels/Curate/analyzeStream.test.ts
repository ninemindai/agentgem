import { describe, it, expect } from "vitest";
import { createClient, type Client } from "@agentback/client";
import { openAnalyzeStream, type AnalyzeEvent } from "./analyzeStream.js";

const CANDIDATE = { name: "auth-flow", description: "sign-in gem", confidence: "high", include: [{ type: "skill", name: "login" }] };

// A client whose fetch replays `items` as a text/event-stream body — the wire the
// server's streamOf route produces. Drives the real route.stream() consumer
// (URL building, SSE parse, per-event validation) without a live server.
function sseClient(items: unknown[], onUrl?: (url: string) => void): Client {
  const fetch = (async (url: string | URL | Request) => {
    onUrl?.(String(url));
    const body = items.map((i) => `data: ${JSON.stringify(i)}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return createClient({ baseURL: "http://console.test", fetch });
}

function run(client: Client, root: string, fresh = false): Promise<AnalyzeEvent[]> {
  return new Promise((resolve) => {
    const events: AnalyzeEvent[] = [];
    openAnalyzeStream(client, root, fresh, (e) => {
      events.push(e);
      if (e.type === "done" || e.type === "failed") resolve(events);
    });
  });
}

describe("openAnalyzeStream", () => {
  it("forwards phase/delta/done and passes candidates through", async () => {
    const events = await run(sseClient([
      { type: "phase", phase: "scanning" },
      { type: "phase", phase: "scanned", transcripts: 4, sessions: 2 },
      { type: "delta", text: "thinking…" },
      { type: "done", cached: false, candidates: [CANDIDATE] },
    ]), "/home/me/proj");

    expect(events.map((e) => e.type)).toEqual(["phase", "phase", "delta", "done"]);
    expect(events[1]).toMatchObject({ type: "phase", phase: "scanned", transcripts: 4, sessions: 2 });
    const done = events[3];
    expect(done).toMatchObject({ type: "done", cached: false });
    if (done.type === "done") expect(done.candidates).toEqual([CANDIDATE]);
  });

  it("puts the project root and fresh=1 on the request", async () => {
    let seen = "";
    await run(sseClient([{ type: "done", cached: false, candidates: [] }], (u) => { seen = u; }), "/home/me/proj", true);
    expect(seen).toContain("root=%2Fhome%2Fme%2Fproj");
    expect(seen).toContain("fresh=1");
  });

  it("forwards a failed event", async () => {
    const events = await run(sseClient([{ type: "failed", message: "boom" }]), "/p");
    expect(events).toEqual([{ type: "failed", message: "boom" }]);
  });
});
