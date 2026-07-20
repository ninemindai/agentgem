// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/scorecard.stream.schema.ts
//
// Zod schema set for the goldmine scorecard SSE scan (GET /api/scorecard/stream),
// shared by the server (scorecard.stream.controller.ts) and mirrored by the
// console. Tracking-free (no ReportRegistry). Stale-while-revalidate: a `stale`
// event paints the cached scorecard first, then `start` → per-project `progress`
// → `done`. The rich scorecard is an opaque `z.unknown()` passthrough (the console
// casts); the small progress `partial` is modelled precisely.
import { z } from "zod";

export const ScorecardStreamQuery = z.object({
  projects: z.string().optional(), // JSON array of project roots; parsed in the route
  dir: z.string().optional(),
  refresh: z.string().optional(), // "true" bypasses the cache (Re-scan)
});
export type ScorecardStreamQuery = z.infer<typeof ScorecardStreamQuery>;

const PartialScore = z.object({ breadth: z.number(), battleTested: z.number(), portable: z.number() });

export const ScorecardEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stale"), scorecard: z.unknown(), updatedAt: z.number() }),
  z.object({ type: z.literal("start"), total: z.number() }),
  z.object({ type: z.literal("progress"), done: z.number(), total: z.number(), label: z.string(), partial: PartialScore }),
  z.object({ type: z.literal("done"), scorecard: z.unknown(), cached: z.boolean(), updatedAt: z.number() }),
  z.object({ type: z.literal("failed"), message: z.string() }),
]);
export type ScorecardEvent = z.infer<typeof ScorecardEvent>;
