// Session-analysis workflow stream (named events phase/delta/done/failed,
// modelled as one discriminated union). Consumed via @agentback/client's typed
// `route.stream()` over the server's `streamOf:` route — each event validated
// against the same schema shape the server yields (mirrored here because the
// console can't import root `src/`; api/routes.ts mirrors server schemas too).
import { z } from "zod";
import { defineRoute, type Client } from "@agentback/client";

export interface AnalyzeCandidate {
  name: string;
  description: string;
  confidence: string;
  include: { type: string; name: string }[];
}

// Panel-facing union: `candidates` typed as the cards the panel renders. The wire
// schema below keeps them opaque (array of unknown); the bridge casts once.
export type AnalyzeEvent =
  | { type: "phase"; phase: string; transcripts?: number; sessions?: number }
  | { type: "delta"; text: string }
  | { type: "done"; cached: boolean; candidates: AnalyzeCandidate[] }
  | { type: "failed"; message: string };

const AnalyzeWireEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("phase"), phase: z.string(), transcripts: z.number().optional(), sessions: z.number().optional() }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("done"), cached: z.boolean(), candidates: z.array(z.unknown()) }),
  z.object({ type: z.literal("failed"), message: z.string() }),
]);

const analyzeStreamRoute = defineRoute("GET", "/api/workflow/analyze/stream", {
  query: z.object({ root: z.string(), dir: z.string().optional(), fresh: z.enum(["0", "1"]).optional() }),
  streamOf: AnalyzeWireEvent,
});

/**
 * Open the workflow-analysis stream. Same `(onEvent) => cleanup` contract the
 * panel already uses, but typed end to end and validated per event. Returns a
 * function that aborts the stream (also stops the server generator via res.close).
 */
export function openAnalyzeStream(
  client: Client,
  root: string,
  fresh: boolean,
  onEvent: (e: AnalyzeEvent) => void,
): () => void {
  const ctrl = new AbortController();
  void (async () => {
    try {
      const stream = analyzeStreamRoute.stream(
        client,
        { query: { root, fresh: fresh ? "1" : "0" } },
        { signal: ctrl.signal },
      );
      for await (const e of stream) {
        if (e.type === "done") onEvent({ ...e, candidates: e.candidates as AnalyzeCandidate[] });
        else onEvent(e);
      }
    } catch {
      if (!ctrl.signal.aborted) onEvent({ type: "failed", message: "stream connection error" });
    }
  })();
  return () => ctrl.abort();
}
