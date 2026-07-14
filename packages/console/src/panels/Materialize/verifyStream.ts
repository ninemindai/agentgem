// Streaming cross-agent verify: named events tagged per agent (one stream for N
// agents), modelled as one discriminated union and consumed via @agentback/client's
// typed `route.stream()`. The wire nests the arbitrary tool/verdict payloads under
// a key (z.unknown()); this bridge extracts the bits the panel shows.
import { z } from "zod";
import { defineRoute, type Client } from "@agentback/client";

export type VerifyStatus = "passed" | "failed" | "unavailable";
export type VerifyVerdict = { agent: string; status: VerifyStatus; detail?: string };
export type VerifyEvent =
  | { type: "agent-start"; agent: string }
  | { type: "tool"; agent: string; label: string }
  | { type: "delta"; agent: string; text: string }
  | { type: "verdict"; agent: string; status: VerifyStatus; detail?: string }
  | { type: "done"; verdicts: VerifyVerdict[] }
  | { type: "failed"; message: string };

function toolLabel(tool: unknown): string {
  if (tool && typeof tool === "object") {
    const t = tool as Record<string, unknown>;
    if (typeof t.title === "string") return t.title;
    if (typeof t.name === "string") return t.name;
  }
  return "tool";
}

const VerifyWireEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent-start"), agent: z.string() }),
  z.object({ type: z.literal("tool"), agent: z.string(), tool: z.unknown() }),
  z.object({ type: z.literal("delta"), agent: z.string(), text: z.string() }),
  z.object({ type: z.literal("verdict"), verdict: z.unknown() }),
  z.object({ type: z.literal("done"), verdicts: z.unknown(), gemName: z.string().optional(), gemDigest: z.string().optional() }),
  z.object({ type: z.literal("failed"), message: z.string() }),
]);

const verifyStreamRoute = defineRoute("GET", "/api/gem/verify/stream", {
  query: z.object({ verifyId: z.string() }),
  streamOf: VerifyWireEvent,
});

/** Open the verify SSE stream; returns a close function (aborts the stream). */
export function openVerifyStream(
  client: Client,
  verifyId: string,
  onEvent: (e: VerifyEvent) => void,
): () => void {
  const ctrl = new AbortController();
  void (async () => {
    try {
      for await (const e of verifyStreamRoute.stream(client, { query: { verifyId } }, { signal: ctrl.signal })) {
        if (e.type === "agent-start") onEvent({ type: "agent-start", agent: e.agent });
        else if (e.type === "tool") onEvent({ type: "tool", agent: e.agent, label: toolLabel(e.tool) });
        else if (e.type === "delta") onEvent({ type: "delta", agent: e.agent, text: e.text });
        else if (e.type === "verdict") { const v = e.verdict as VerifyVerdict; onEvent({ type: "verdict", agent: v.agent, status: v.status, detail: v.detail }); }
        else if (e.type === "done") onEvent({ type: "done", verdicts: e.verdicts as VerifyVerdict[] });
        else onEvent({ type: "failed", message: e.message });
      }
    } catch {
      if (!ctrl.signal.aborted) onEvent({ type: "failed", message: "stream connection error" });
    }
  })();
  return () => ctrl.abort();
}
