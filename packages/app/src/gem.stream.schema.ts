// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem.stream.schema.ts
//
// Zod schema sets for the two prepared-then-streamed gem SSE routes — GET
// /api/gem/run/stream and GET /api/gem/verify/stream — shared by the server
// (gem.stream.controller.ts) and mirrored by the console. Both are tracking-free
// (no ReportRegistry): a prepared id → run an agent → per-agent progress → done.
// Rich/arbitrary payloads (the tool invocation, the run result, the verdicts) are
// nested under a key as `z.unknown()` passthroughs — the console casts — which
// keeps each event a clean discriminated-union member for `streamOf:` validation.
import { z } from "zod";

// ---- run ----
export const GemRunStreamQuery = z.object({
  runId: z.string().min(1),
  task: z.string().optional(),
  expectTools: z.string().optional(), // comma-separated; split in the route
  expectText: z.string().optional(),
});
export type GemRunStreamQuery = z.infer<typeof GemRunStreamQuery>;

export const RunEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("phase"), phase: z.string(), agent: z.string().optional(), pkg: z.string().optional() }),
  z.object({ type: z.literal("tool"), tool: z.unknown() }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("done"), result: z.unknown() }),
  z.object({ type: z.literal("failed"), message: z.string() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;

// ---- verify ----
export const GemVerifyStreamQuery = z.object({ verifyId: z.string().min(1) });
export type GemVerifyStreamQuery = z.infer<typeof GemVerifyStreamQuery>;

export const VerifyEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent-start"), agent: z.string() }),
  z.object({ type: z.literal("tool"), agent: z.string(), tool: z.unknown() }),
  z.object({ type: z.literal("delta"), agent: z.string(), text: z.string() }),
  z.object({ type: z.literal("verdict"), verdict: z.unknown() }),
  z.object({ type: z.literal("done"), verdicts: z.unknown(), gemName: z.string().optional(), gemDigest: z.string().optional() }),
  z.object({ type: z.literal("failed"), message: z.string() }),
]);
export type VerifyEvent = z.infer<typeof VerifyEvent>;
