// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/rubric.stream.schema.ts
//
// Zod schema set for the rubric-evaluation SSE stream (GET /api/rubric/stream),
// shared by the server route (rubric.controller.ts) and mirrored by the console
// client. Unlike insights/workflow the terminal-report stream opens with a
// `start` event carrying rubric metadata (no `phase` events); scope-dependent
// validation (unknown rubric, bad scope) stays a `failed` event, not a 422, so
// the panel shows the message. Still one discriminated union for `streamOf:`.
import { z } from "zod";

/** Query bundle for GET /api/rubric/stream (framework-validated). Scope-conditional
 * requirements (project→root, session→root+sessionId) are validated in the route as
 * `failed` events, not here, to preserve the raw handler's user-facing messages. */
export const RubricStreamQuery = z.object({
  rubric: z.string().min(1),
  scope: z.enum(["session", "project", "all"]).optional(),
  root: z.string().optional(),
  sessionId: z.string().optional(),
  dir: z.string().optional(),
  refresh: z.string().optional(), // "true" bypasses the cache (Re-run)
});
export type RubricStreamQuery = z.infer<typeof RubricStreamQuery>;

const StartEvent = z.object({
  type: z.literal("start"),
  rubric: z.string(),
  title: z.string(),
  target: z.string(),
  scope: z.string(),
});
const DeltaEvent = z.object({ type: z.literal("delta"), text: z.string() });
const DoneEvent = z.object({
  type: z.literal("done"),
  // The rich RubricReportView the console renders — opaque passthrough
  // (`z.unknown()`), same rationale as insights' `report`.
  report: z.unknown(),
  cached: z.boolean(),
  updatedAt: z.number().nullable(),
});
const FailedEvent = z.object({ type: z.literal("failed"), message: z.string() });

/** One rubric-evaluation event. Per-item schema for the `streamOf:` route. */
export const RubricEvent = z.discriminatedUnion("type", [
  StartEvent,
  DeltaEvent,
  DoneEvent,
  FailedEvent,
]);
export type RubricEvent = z.infer<typeof RubricEvent>;
