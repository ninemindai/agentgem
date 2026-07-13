// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/rubric.controller.ts
//
// The rubric catalog + authoring REST surface, on the AgentBack decorator
// dispatch (was four raw `server.expressApp` routes in index.ts). Moving them
// here buys Zod input validation, OpenAPI emission, and the framework's
// originGuard — which is mounted as framework middleware (index.ts), so it runs
// before controller dispatch and these routes need no per-route guard.
//
// The validate/save bodies stay PERMISSIVE (z.unknown()): the editor posts an
// arbitrary draft and the endpoint answers 200 with inline errors — a strict body
// schema would 422 a malformed draft before validateRubricInput could describe
// what's wrong. The real, structural validation lives in rubricCore.validateRubric.
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { inject } from "@agentback/core";
import { listRubricsWithMeta, validateRubricInput, saveRubric, deleteRubric, computeRubric as realComputeRubric, resolveRubric } from "./rubricCore.js";
import { scopeAllowed, type RubricScope } from "@agentgem/insight";
import { beginForeground, endForeground } from "./warm/orchestrator.js";
import { ReportRegistry, REPORT_REGISTRY } from "./report/registry.js";
import { trackerFor, rubricParamsKey, queryParams } from "./report/track.js";
import { pump } from "./sse/pump.js";
import { RubricStreamQuery, RubricEvent } from "./rubric.stream.schema.js";

// The Rubric shape (packages/insight/src/rubrics.ts), mirrored so /openapi.json
// describes the catalog + validation payloads. Response validation is advisory
// (rest.server logs a debug on mismatch, never strips), so this documents the
// contract without any risk to the body the console consumes.
const RubricFactorRefSchema = z.object({ factor: z.string(), weight: z.number().optional() });
const LlmCriterionSchema = z.object({
  id: z.string(),
  title: z.string(),
  question: z.string(),
  severity: z.enum(["info", "warn"]).optional(),
  advice: z.string(),
  granularity: z.enum(["session", "aggregate"]).optional(),
});
const RubricSchema = z.object({
  id: z.string(),
  title: z.string(),
  target: z.string(),
  naturalScope: z.enum(["session", "project", "all"]).optional(),
  factors: z.array(RubricFactorRefSchema),
  criteria: z.array(LlmCriterionSchema).optional(),
});
// listRubricsWithMeta adds the `builtin` flag the picker gates edit/delete on.
const RubricWithBuiltinSchema = RubricSchema.extend({ builtin: z.boolean() });
const FactorKindSchema = z.object({
  factor: z.string(),
  kind: z.enum(["detector", "rule", "criterion", "unknown"]),
});
// The RubricValidation contract (rubricCore.ts): valid + the resolved rubric, its
// factor-kind preview, and unknown-factor warnings; `saved` set by the save path.
const RubricValidationSchema = z.object({
  valid: z.boolean(),
  error: z.string().optional(),
  rubric: RubricSchema.optional(),
  factors: z.array(FactorKindSchema).optional(),
  unknownFactors: z.array(z.string()).optional(),
  saved: z.boolean().optional(),
});

const RubricListQuerySchema = z.object({ dir: z.string().optional() });
const RubricListResponseSchema = z.object({ rubrics: z.array(RubricWithBuiltinSchema) });
const RubricDeleteBodySchema = z.object({ id: z.string() });
const RubricDeleteResponseSchema = z.object({ deleted: z.boolean(), error: z.string().optional() });

// Test seam: swap computeRubric so the stream route can be driven without the
// spine scan / ACP stack. resolveRubric stays real (built-in rubrics resolve
// in-memory). Mirrors setInsightsComputeForTests / setWorkflowComputeForTests.
type ComputeRubric = typeof realComputeRubric;
let computeFn: ComputeRubric = realComputeRubric;
export function setRubricComputeForTests(fn: ComputeRubric | null): void {
  computeFn = fn ?? realComputeRubric;
}

const str = (q: unknown): string | undefined => (typeof q === "string" && q ? q : undefined);

// Parse ?scope=&root=&sessionId= into a RubricScope, or a user-facing error
// message (surfaced as a `failed` event, not a 422 — moved from rubricStream.ts).
function parseScope(q: { scope?: string; root?: string; sessionId?: string }): RubricScope | { error: string } {
  const kind = q.scope ?? "project";
  if (kind === "all") return { kind: "all" };
  if (kind === "project") {
    if (!q.root) return { error: "project scope requires ?root=" };
    return { kind: "project", root: q.root };
  }
  const sessionId = str(q.sessionId);
  if (!q.root || !sessionId) return { error: "session scope requires ?root= and ?sessionId=" };
  return { kind: "session", root: q.root, sessionId };
}

@api({ basePath: "/api" })
export class RubricController {
  // Optional so the catalog/authoring routes (and their supertest) construct
  // without a bound registry; the stream route uses it for report-run tracking
  // (kind "rubric"), shared with the analyze/insights routes + /api/report/runs.
  constructor(
    @inject(REPORT_REGISTRY, { optional: true }) private reportRegistry?: ReportRegistry,
  ) {}

  // GET /api/rubric/stream — SSE evaluation of one rubric at a scope. Opens with a
  // `start` event (rubric metadata), streams LLM-criterion deltas (Phase 2), then
  // `done`. Business failures (unknown rubric, bad scope) are `failed` events, not
  // 422s, so the panel shows the message. Drives the report registry (kind "rubric").
  @get("/rubric/stream", { query: RubricStreamQuery, streamOf: RubricEvent })
  async *stream(input: {
    query: z.infer<typeof RubricStreamQuery>;
  }): AsyncGenerator<z.infer<typeof RubricEvent>> {
    const { rubric: id, dir, refresh } = input.query;
    const fresh = refresh === "true"; // ?refresh=true bypasses the cache
    const track = this.reportRegistry
      ? trackerFor(this.reportRegistry, "rubric", rubricParamsKey(input.query as Record<string, unknown>), queryParams(input.query as Record<string, unknown>), fresh)
      : undefined;
    // begin/end in the producer (not the generator's finally) so the foreground
    // gate is held through a client disconnect — see sse/pump.ts.
    yield* pump<z.infer<typeof RubricEvent>>(async (emit) => {
      beginForeground();
      try {
        const rubric = resolveRubric(id, dir);
        if (!rubric) { const m = `unknown rubric: ${id}`; emit({ type: "failed", message: m }); track?.failed(m); return; }
        const scope = parseScope(input.query);
        if ("error" in scope) { emit({ type: "failed", message: scope.error }); track?.failed(scope.error); return; }
        // Hard rule: an aggregate-only rubric can't run at session scope.
        if (!scopeAllowed(rubric, scope.kind)) {
          const m = `rubric "${rubric.id}" is aggregate-only and cannot run at scope "${scope.kind}"`;
          emit({ type: "failed", message: m }); track?.failed(m); return;
        }
        emit({ type: "start", rubric: rubric.id, title: rubric.title, target: rubric.target, scope: scope.kind });
        track?.phase("evaluating");
        const { payload, cached, updatedAt } = await computeFn(rubric, scope, {
          dir, force: fresh, onDelta: (chunk) => emit({ type: "delta", text: chunk }),
        });
        emit({ type: "done", report: payload, cached, updatedAt });
        track?.done();
      } catch (err) {
        const m = (err as Error)?.message ?? String(err);
        emit({ type: "failed", message: m }); track?.failed(m);
      } finally {
        endForeground();
      }
    });
  }

  // GET /api/rubrics?dir= — built-in + user rubrics for the picker.
  @get("/rubrics", { query: RubricListQuerySchema, response: RubricListResponseSchema })
  async list(input: { query: z.infer<typeof RubricListQuerySchema> }): Promise<z.infer<typeof RubricListResponseSchema>> {
    return { rubrics: listRubricsWithMeta(input.query.dir) };
  }

  // POST /api/rubrics/validate — dry-run for the live editor; always 200 with the
  // result (valid:false + error for a bad draft), never a 422. Body stays z.unknown().
  @post("/rubrics/validate", { body: z.unknown(), response: RubricValidationSchema })
  async validate(input: { body: unknown }): Promise<z.infer<typeof RubricValidationSchema>> {
    return validateRubricInput(input.body);
  }

  // POST /api/rubrics — validate + write a user rubric to ~/.agentgem/rubrics/<id>.json.
  @post("/rubrics", { body: z.unknown(), response: RubricValidationSchema })
  async save(input: { body: unknown }): Promise<z.infer<typeof RubricValidationSchema>> {
    return saveRubric(input.body);
  }

  // POST /api/rubrics/delete — remove a user rubric (built-ins are protected). Unlike
  // the raw route it replaced, a missing/blank id is now a 422 (schema-gated) rather
  // than a 200 {deleted:false}; the console always sends a concrete id.
  @post("/rubrics/delete", { body: RubricDeleteBodySchema, response: RubricDeleteResponseSchema })
  async remove(input: { body: z.infer<typeof RubricDeleteBodySchema> }): Promise<z.infer<typeof RubricDeleteResponseSchema>> {
    return deleteRubric(input.body.id);
  }
}
