// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/insights.stream.schema.ts
//
// One Zod schema set for the insights SSE stream, shared by the server route
// (insights.controller.ts) and mirrored by the console client (the console is a
// separate, browser-safe package and cannot import root `src/`, matching how
// api/routes.ts already mirrors every server schema — "extracted later").
//
// The named SSE events (phase/delta/done/failed) are modelled as ONE
// DISCRIMINATED UNION keyed on `type`. That is what lets a multi-event progress
// stream ride agentback's single-schema `streamOf:` — and it buys per-event
// runtime validation the raw `send(event, JSON.stringify(data))` never had.
import { z } from "zod";

/** Query bundle for GET /api/insights/stream (validated by the framework). */
export const InsightsStreamQuery = z.object({
  root: z.string().min(1),
  dir: z.string().optional(),
  fresh: z.enum(["0", "1"]).optional(), // "1" bypasses the cache (Re-run)
});
export type InsightsStreamQuery = z.infer<typeof InsightsStreamQuery>;

const PhaseEvent = z.object({
  type: z.literal("phase"),
  phase: z.string(),
  transcripts: z.number().optional(),
  sessions: z.number().optional(),
});
const DeltaEvent = z.object({ type: z.literal("delta"), text: z.string() });
const DoneEvent = z.object({
  type: z.literal("done"),
  // The rich InsightsPayload.report — an opaque passthrough (the console reads
  // it whole and hands it to InsightsReportView). `z.unknown()` is the accurate
  // schema: stream item validation is STRICT (a mismatch terminates the stream),
  // and constraining a rich passthrough would restate a shape we don't validate
  // (and `z.looseObject({})` infers `Record<string, unknown>`, which the concrete
  // report type isn't assignable to — no index signature).
  report: z.unknown(),
  degraded: z.boolean(),
  scanned: z.number().optional(),
  updatedAt: z.number().nullable(),
});
const FailedEvent = z.object({ type: z.literal("failed"), message: z.string() });

/** One insights progress event. Per-item schema for the `streamOf:` route. */
export const InsightsEvent = z.discriminatedUnion("type", [
  PhaseEvent,
  DeltaEvent,
  DoneEvent,
  FailedEvent,
]);
export type InsightsEvent = z.infer<typeof InsightsEvent>;
