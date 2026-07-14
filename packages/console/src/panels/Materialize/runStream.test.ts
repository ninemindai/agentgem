import { describe, it, expect } from "vitest";
import { createClient, type Client } from "@agentback/client";
import { openRunStream, type RunEvent } from "./runStream.js";

// A client whose fetch replays `items` as a text/event-stream body — the wire the
// server's streamOf route produces. Drives the real route.stream() consumer.
function sseClient(items: unknown[], onUrl?: (url: string) => void): Client {
  const fetch = (async (url: string | URL | Request) => {
    onUrl?.(String(url));
    const body = items.map((i) => `data: ${JSON.stringify(i)}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return createClient({ baseURL: "http://console.test", fetch });
}

function run(client: Client, runId: string, task: string): Promise<RunEvent[]> {
  return new Promise((resolve) => {
    const events: RunEvent[] = [];
    openRunStream(client, runId, task, (e) => {
      events.push(e);
      if (e.type === "done" || e.type === "failed") resolve(events);
    });
  });
}

describe("openRunStream", () => {
  it("translates the streamOf events (tool label extracted from the nested payload)", async () => {
    let seen = "";
    const events = await run(sseClient([
      { type: "phase", phase: "running", agent: "claude" },
      { type: "tool", tool: { name: "read_file" } },
      { type: "delta", text: "hello " },
      { type: "delta", text: "world" },
      { type: "done", result: {} },
    ], (u) => { seen = u; }), "run-1", "do the thing");

    expect(events).toEqual([
      { type: "phase", phase: "running", agent: "claude" },
      { type: "tool", label: "read_file" },
      { type: "delta", text: "hello " },
      { type: "delta", text: "world" },
      { type: "done" },
    ]);
    expect(seen).toContain("runId=run-1");
    expect(seen).toContain("task=do+the+thing");
  });

  it("reports failed events", async () => {
    const events = await run(sseClient([{ type: "failed", message: "boom" }]), "r", "t");
    expect(events).toEqual([{ type: "failed", message: "boom" }]);
  });
});
