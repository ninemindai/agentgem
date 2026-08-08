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

/** Query for GET /api/rubric/report — same scope addressing as the evaluation
 *  stream. No `refresh`: the report renders from the (cached) evaluation; a
 *  fresh evaluation happens on the evaluation stream, not here. */
export const RubricReportStreamQuery = z.object({
  rubric: z.string().min(1),
  scope: z.enum(["session", "project", "all"]).optional(),
  root: z.string().optional(),
  sessionId: z.string().optional(),
  dir: z.string().optional(),
});
export type RubricReportStreamQuery = z.infer<typeof RubricReportStreamQuery>;

const ReportStartEvent = z.object({ type: z.literal("start"), rubric: z.string(), title: z.string(), scope: z.string() });
// `html` is the finished self-contained document (already capped server-side).
const ReportDoneEvent = z.object({ type: z.literal("done"), html: z.string(), truncated: z.boolean() });

/** One report-render event. Reuses the evaluation stream's delta/failed shapes. */
export const RubricReportEvent = z.discriminatedUnion("type", [
  ReportStartEvent,
  DeltaEvent,
  ReportDoneEvent,
  FailedEvent,
]);
export type RubricReportEvent = z.infer<typeof RubricReportEvent>;

/**
 * Body for POST /api/rubric/verdict. STRICT, unlike the deliberately permissive
 * /rubrics and /rubrics/validate bodies — those accept an arbitrary editor draft so
 * the endpoint can describe what is wrong. There is no draft here: a malformed
 * verdict is a client bug and 422 is the right answer. `atMs` is server-assigned,
 * so sending one is rejected rather than ignored.
 */
export const RubricVerdictBody = z.object({
  sessionId: z.string().min(1),
  factorId: z.string().min(1),
  rubricId: z.string().min(1),
  verdict: z.enum(["accepted", "wrong", "wontfix"]),
  note: z.string().max(500).optional(),
}).strict();
export type RubricVerdictBody = z.infer<typeof RubricVerdictBody>;

/**
 * The response carries the factor's REFRESHED calibration so the console can update
 * the rate in place. Without it the button flips but the line beside it keeps showing
 * the pre-click count until the next full report fetch, which reads as a failed write.
 */
export const RubricVerdictResponse = z.object({
  ok: z.literal(true),
  atMs: z.number(),
  calibration: z.object({
    reviewed: z.number(), accepted: z.number(), wrong: z.number(), wontfix: z.number(),
  }),
});
export type RubricVerdictResponse = z.infer<typeof RubricVerdictResponse>;
