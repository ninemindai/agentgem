// Scorecard scan stream (named events stale/start/progress/done/failed, modelled
// as one discriminated union). Consumed via @agentback/client's typed
// `route.stream()` over the server's `streamOf:` route — each event validated
// against the same schema shape the server yields (the rich scorecard is an
// opaque wire payload; this bridge casts it to Scorecard).
import { z } from "zod";
import { defineRoute, type Client } from "@agentback/client";
import type { Scorecard } from "../../api/routes.js";

export type ScorecardStreamEvent =
  | { type: "start"; total: number }
  | { type: "stale"; scorecard: Scorecard; updatedAt: number | null }
  | { type: "progress"; done: number; total: number; label: string; partial: { breadth: number; battleTested: number; portable: number } }
  | { type: "done"; scorecard: Scorecard; cached: boolean; updatedAt: number | null }
  | { type: "failed"; message: string };

const PartialScore = z.object({ breadth: z.number(), battleTested: z.number(), portable: z.number() });
const ScorecardWireEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stale"), scorecard: z.unknown(), updatedAt: z.number() }),
  z.object({ type: z.literal("start"), total: z.number() }),
  z.object({ type: z.literal("progress"), done: z.number(), total: z.number(), label: z.string(), partial: PartialScore }),
  z.object({ type: z.literal("done"), scorecard: z.unknown(), cached: z.boolean(), updatedAt: z.number() }),
  z.object({ type: z.literal("failed"), message: z.string() }),
]);

const scorecardStreamRoute = defineRoute("GET", "/api/scorecard/stream", {
  query: z.object({ projects: z.string().optional(), refresh: z.string().optional() }),
  streamOf: ScorecardWireEvent,
});

/** Open the scorecard scan stream; returns a close function (aborts the stream). */
export function openScorecardStream(
  client: Client,
  onEvent: (e: ScorecardStreamEvent) => void,
  opts?: { refresh?: boolean; projects?: string[] },
): () => void {
  const ctrl = new AbortController();
  const query: { projects?: string; refresh?: string } = {};
  if (opts?.refresh) query.refresh = "true";
  if (opts?.projects?.length) query.projects = JSON.stringify(opts.projects);
  void (async () => {
    try {
      for await (const e of scorecardStreamRoute.stream(client, { query }, { signal: ctrl.signal })) {
        if (e.type === "stale") onEvent({ type: "stale", scorecard: e.scorecard as Scorecard, updatedAt: e.updatedAt });
        else if (e.type === "done") onEvent({ type: "done", scorecard: e.scorecard as Scorecard, cached: e.cached, updatedAt: e.updatedAt });
        else onEvent(e);
      }
    } catch {
      if (!ctrl.signal.aborted) onEvent({ type: "failed", message: "stream connection error" });
    }
  })();
  return () => ctrl.abort();
}
