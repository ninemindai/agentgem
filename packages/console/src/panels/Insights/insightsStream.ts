// Personal session-insights stream (named events phase/delta/done/failed,
// modelled as one discriminated union). Consumed via @agentback/client's typed
// `route.stream()` over the server's `streamOf:` route — each event is validated
// against the same schema shape the server yields (mirrored here because the
// console can't import root `src/`; api/routes.ts mirrors server schemas too).
import { z } from "zod";
import { defineRoute, type Client } from "@agentback/client";

export interface InsightsReportView {
  totals: { sessions: number; mostly: number; partially: number; not: number };
  outcomes_summary: string;
  narrative: string;
  by_model: { model: string; mostly: number; partially: number; not: number; total: number }[];
  friction: { sessionId: string; detail: string }[];
  publish_candidates: { sessionId: string; goal: string; why: string }[];
}

// Panel-facing union: `report` is typed as the view the charts consume. The wire
// schema below keeps `report` opaque (z.unknown()); the bridge casts once.
export type InsightsEvent =
  | { type: "phase"; phase: string; transcripts?: number; sessions?: number }
  | { type: "delta"; text: string }
  | { type: "done"; report: InsightsReportView; degraded: boolean; scanned?: number; updatedAt: number | null }
  | { type: "failed"; message: string };

const InsightsWireEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("phase"), phase: z.string(), transcripts: z.number().optional(), sessions: z.number().optional() }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("done"), report: z.unknown(), degraded: z.boolean(), scanned: z.number().optional(), updatedAt: z.number().nullable() }),
  z.object({ type: z.literal("failed"), message: z.string() }),
]);

const insightsStreamRoute = defineRoute("GET", "/api/insights/stream", {
  query: z.object({ root: z.string(), dir: z.string().optional(), fresh: z.enum(["0", "1"]).optional() }),
  streamOf: InsightsWireEvent,
});

/**
 * Open the insights stream. Same `(onEvent) => cleanup` contract the panel
 * already uses, but typed end to end and validated per event. Returns a function
 * that aborts the stream (also stops the server generator via `res.close`).
 */
export function openInsightsStream(
  client: Client,
  root: string,
  onEvent: (e: InsightsEvent) => void,
  fresh = false,
): () => void {
  const ctrl = new AbortController();
  void (async () => {
    try {
      const stream = insightsStreamRoute.stream(
        client,
        { query: { root, fresh: fresh ? "1" : "0" } },
        { signal: ctrl.signal },
      );
      for await (const e of stream) {
        if (e.type === "done") onEvent({ ...e, report: e.report as InsightsReportView });
        else onEvent(e);
      }
    } catch {
      if (!ctrl.signal.aborted) onEvent({ type: "failed", message: "stream connection error" });
    }
  })();
  return () => ctrl.abort();
}
