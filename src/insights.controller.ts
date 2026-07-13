// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/insights.controller.ts
//
// The insights SSE report, on the AgentBack `streamOf:` dispatch (was a raw
// handler on server.expressApp — insightsStream.ts). Moving it here buys Zod
// query validation, per-event response validation, OpenAPI emission, and the
// framework's global originGuard (so no per-route guard arg).
//
// The named progress events (phase/delta/done/failed) become one discriminated
// union (insights.stream.schema.ts) so a multi-event stream fits the single-item
// `streamOf:` contract. The one seam the raw handler didn't need: computeInsights
// is PUSH-style (onPhase/onDelta callbacks), while streamOf is PULL-style (yield),
// so `pump` bridges push -> pull. It is generic and can be lifted to a shared
// util as the other ~9 raw SSE routes migrate.
import { z } from "zod";
import { api, get } from "@agentback/openapi";
import { inject } from "@agentback/core";
import { computeInsights as realComputeInsights } from "./insightsCore.js";
import { beginForeground, endForeground } from "./warm/orchestrator.js";
import { ReportRegistry, REPORT_REGISTRY } from "./report/registry.js";
import { trackerFor, insightsParamsKey } from "./report/track.js";
import { pump } from "./sse/pump.js";
import { InsightsStreamQuery, InsightsEvent } from "./insights.stream.schema.js";

// Test seam: swap computeInsights so the route can be driven without the ACP /
// transcript stack. Mirrors @agentgem/run's setRunConnectFnForTests convention.
type ComputeInsights = typeof realComputeInsights;
let computeFn: ComputeInsights = realComputeInsights;
export function setInsightsComputeForTests(fn: ComputeInsights | null): void {
  computeFn = fn ?? realComputeInsights;
}

@api({ basePath: "/api" })
export class InsightsController {
  // The ONE ReportRegistry instance the raw analyze/rubric routes + /api/report/runs
  // share, bound in finalizeCommonApp. Optional so the route (and its tests) run
  // without report-run tracking when nothing is bound.
  constructor(
    @inject(REPORT_REGISTRY, { optional: true }) private reportRegistry?: ReportRegistry,
  ) {}

  // GET /api/insights/stream — Server-Sent Events; each item validated against
  // the InsightsEvent union before it reaches the wire. Also drives the report-run
  // registry (phase/done/failed) so the console can reattach after reload — the
  // same lifecycle the raw handler tracked before this migration.
  @get("/insights/stream", { query: InsightsStreamQuery, streamOf: InsightsEvent })
  async *stream(input: {
    query: z.infer<typeof InsightsStreamQuery>;
  }): AsyncGenerator<z.infer<typeof InsightsEvent>> {
    const { root, dir, fresh } = input.query;
    // trackerFor returns undefined for a reattach (non-fresh open of an already
    // terminal run) so we don't re-begin a finished run.
    const track = this.reportRegistry
      ? trackerFor(this.reportRegistry, "insights", insightsParamsKey({ root }), dir ? { root, dir } : { root }, fresh === "1")
      : undefined;
    // begin/end live in the producer, NOT the generator's finally: on client
    // disconnect the framework calls iterator.return() and the generator unwinds
    // immediately, but computeFn keeps running to populate the cache. Holding the
    // foreground gate around the compute (as the raw handler did — see track.ts)
    // keeps background warming from racing a live user compute post-disconnect.
    yield* pump<z.infer<typeof InsightsEvent>>(async (emit) => {
      beginForeground();
      try {
        const { payload, updatedAt } = await computeFn(root, {
          dir,
          force: fresh === "1",
          progress: {
            onPhase: (phase, extra) => {
              emit({
                type: "phase",
                phase,
                transcripts: extra?.transcripts as number | undefined,
                sessions: extra?.sessions as number | undefined,
              });
              track?.phase(extra?.sessions != null ? `${phase} (${extra.sessions} sessions)` : phase);
            },
            onDelta: (text) => emit({ type: "delta", text }),
          },
        });
        emit({
          type: "done",
          report: payload.report,
          degraded: payload.degraded,
          scanned: payload.signalSummary.sessionsScanned,
          updatedAt,
        });
        track?.done();
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        emit({ type: "failed", message: msg });
        track?.failed(msg);
      } finally {
        endForeground();
      }
    });
  }
}
