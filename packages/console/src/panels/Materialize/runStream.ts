// The run stream (named events phase/tool/delta/done/failed, modelled as one
// discriminated union) consumed via @agentback/client's typed `route.stream()`
// over the server's `streamOf:` route. The wire nests the arbitrary tool/run
// payloads under a key (z.unknown()); this bridge extracts the bits the panel
// shows. (The POST /prepare step also goes through the typed client.)
import { z } from "zod";
import { defineRoute, type Client } from "@agentback/client";

export type RunEvent =
  | { type: "phase"; phase: string; agent?: string }
  | { type: "tool"; label: string }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "failed"; message: string };

function toolLabel(tool: unknown): string {
  if (tool && typeof tool === "object") {
    const t = tool as Record<string, unknown>;
    if (typeof t.name === "string") return t.name;
    if (typeof t.title === "string") return t.title;
  }
  return "tool";
}

const RunWireEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("phase"), phase: z.string(), agent: z.string().optional(), pkg: z.string().optional() }),
  z.object({ type: z.literal("tool"), tool: z.unknown() }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("done"), result: z.unknown() }),
  z.object({ type: z.literal("failed"), message: z.string() }),
]);

const runStreamRoute = defineRoute("GET", "/api/gem/run/stream", {
  query: z.object({ runId: z.string(), task: z.string().optional() }),
  streamOf: RunWireEvent,
});

/** Open the run SSE stream; returns a close function (aborts the stream). */
export function openRunStream(
  client: Client,
  runId: string,
  task: string,
  onEvent: (e: RunEvent) => void,
): () => void {
  const ctrl = new AbortController();
  void (async () => {
    try {
      for await (const e of runStreamRoute.stream(client, { query: { runId, task } }, { signal: ctrl.signal })) {
        if (e.type === "phase") onEvent({ type: "phase", phase: e.phase, agent: e.agent });
        else if (e.type === "tool") onEvent({ type: "tool", label: toolLabel(e.tool) });
        else if (e.type === "delta") onEvent({ type: "delta", text: e.text });
        else if (e.type === "done") onEvent({ type: "done" });
        else onEvent({ type: "failed", message: e.message });
      }
    } catch {
      if (!ctrl.signal.aborted) onEvent({ type: "failed", message: "stream connection error" });
    }
  })();
  return () => ctrl.abort();
}
