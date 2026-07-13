// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/workflow.stream.schema.ts
//
// Zod schema set for the workflow-analysis SSE stream (GET /api/workflow/analyze/
// stream), shared by the server route (workflow.controller.ts) and mirrored by
// the console client. Same shape as the insights stream: the named progress
// events (phase/delta/done/failed) become one discriminated union so a
// multi-event stream fits agentback's single-item `streamOf:` contract, with
// per-event runtime validation.
import { z } from "zod";

/** Query bundle for GET /api/workflow/analyze/stream (framework-validated). */
export const WorkflowStreamQuery = z.object({
  root: z.string().min(1),
  dir: z.string().optional(),
  fresh: z.enum(["0", "1"]).optional(), // "1" bypasses the cache (Re-analyze)
});
export type WorkflowStreamQuery = z.infer<typeof WorkflowStreamQuery>;

const PhaseEvent = z.object({
  type: z.literal("phase"),
  phase: z.string(),
  transcripts: z.number().optional(),
  sessions: z.number().optional(),
});
const DeltaEvent = z.object({ type: z.literal("delta"), text: z.string() });
const DoneEvent = z.object({
  type: z.literal("done"),
  cached: z.boolean(),
  // The gem candidates the console renders. Opaque passthrough (`z.array(z.unknown())`)
  // for the same reason insights' `report` is `z.unknown()`: constraining a rich
  // payload restates a shape we don't validate, and stream validation is strict.
  candidates: z.array(z.unknown()),
});
const FailedEvent = z.object({ type: z.literal("failed"), message: z.string() });

/** One workflow-analysis progress event. Per-item schema for the `streamOf:` route. */
export const WorkflowEvent = z.discriminatedUnion("type", [
  PhaseEvent,
  DeltaEvent,
  DoneEvent,
  FailedEvent,
]);
export type WorkflowEvent = z.infer<typeof WorkflowEvent>;
