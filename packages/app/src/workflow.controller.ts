// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/workflow.controller.ts
//
// The workflow-analysis SSE report, on the AgentBack `streamOf:` dispatch (was a
// raw handler on server.expressApp — workflowStream.ts). Second SSE route to
// migrate off the raw handlers, after InsightsController; both now share the
// push->pull `pump` bridge (src/sse/pump.ts) and the report-run tracking pattern
// (ReportRegistry injected via REPORT_REGISTRY, driven through trackerFor).
//
// The non-streaming POST /api/workflow/analyze stays in gem.controller.ts for
// programmatic/test callers — untouched.
import { z } from "zod";
import { api, get } from "@agentback/openapi";
import { inject } from "@agentback/core";
import { computeWorkflowAnalysis as realComputeWorkflow } from "./workflowCore.js";
import { beginForeground, endForeground } from "./warm/orchestrator.js";
import { ReportRegistry, REPORT_REGISTRY } from "./report/registry.js";
import { trackerFor, analyzeParamsKey } from "./report/track.js";
import { pump } from "./sse/pump.js";
import { WorkflowStreamQuery, WorkflowEvent } from "./workflow.stream.schema.js";

// Test seam: swap computeWorkflowAnalysis so the route can be driven without the
// transcript/ACP stack. Mirrors setInsightsComputeForTests.
type ComputeWorkflow = typeof realComputeWorkflow;
let computeFn: ComputeWorkflow = realComputeWorkflow;
export function setWorkflowComputeForTests(fn: ComputeWorkflow | null): void {
  computeFn = fn ?? realComputeWorkflow;
}

@api({ basePath: "/api" })
export class WorkflowController {
  // Shares the ONE ReportRegistry bound in finalizeCommonApp (kind "analyze"),
  // so /api/report/runs + console reattach see workflow runs too. Optional so
  // the route (and its tests) run without tracking when nothing is bound.
  constructor(
    @inject(REPORT_REGISTRY, { optional: true }) private reportRegistry?: ReportRegistry,
  ) {}

  // GET /api/workflow/analyze/stream — SSE; each item validated against the
  // WorkflowEvent union before the wire. Drives the report-run registry
  // (phase/done/failed) like the raw handler did.
  @get("/workflow/analyze/stream", { query: WorkflowStreamQuery, streamOf: WorkflowEvent })
  async *stream(input: {
    query: z.infer<typeof WorkflowStreamQuery>;
  }): AsyncGenerator<z.infer<typeof WorkflowEvent>> {
    const { root, dir, fresh } = input.query;
    const track = this.reportRegistry
      ? trackerFor(this.reportRegistry, "analyze", analyzeParamsKey({ root }), dir ? { root, dir } : { root }, fresh === "1")
      : undefined;
    // begin/end in the producer (not the generator's finally): hold the foreground
    // gate for the full compute even after a client disconnect. See pump.ts / the
    // insights controller for the rationale.
    yield* pump<z.infer<typeof WorkflowEvent>>(async (emit) => {
      beginForeground();
      try {
        const { payload, cached } = await computeFn(root, {
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
        emit({ type: "done", cached, candidates: payload.candidates });
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
