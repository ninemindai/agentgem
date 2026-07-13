// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Bridges an SSE report route to the ReportRegistry. makeTracker() marks the run
// running immediately (begin), then the route forwards phase/done/failed. The
// terminal calls run AFTER the route's awaited compute settles, so they record
// correctly even when the client disconnected mid-run (background completion).
import type { ReportRegistry } from "./registry.js";

export interface RunTracker { phase(p: string): void; done(): void; failed(msg: string): void }

export function makeTracker(reg: ReportRegistry, kind: string, paramsKey: string, params: Record<string, string>): RunTracker {
  reg.begin(kind, paramsKey, params);
  return {
    phase: (p) => reg.phase(kind, paramsKey, p),
    done: () => reg.finish(kind, paramsKey, "done"),
    failed: (msg) => reg.finish(kind, paramsKey, "failed", msg),
  };
}

// Decide whether a stream open should be tracked as a run, or is a reattach/re-view
// that must NOT re-register the run. The client reattaches by re-opening the SAME
// cache-backed stream to load a finished report; without this guard makeTracker
// would begin() again, reset startedAt to "now", and trip detectReportDone's
// first-poll baseline into a spurious "report ready" toast on every app open. So:
// a NON-fresh open of a key that already has a TERMINAL run is a reattach — skip it.
// A fresh open (Re-run) or a first open (no record, or a still-running one) tracks.
export function trackerFor(
  reg: ReportRegistry,
  kind: string,
  paramsKey: string,
  params: Record<string, string>,
  fresh: boolean,
): RunTracker | undefined {
  if (!fresh) {
    const existing = reg.get(kind, paramsKey);
    if (existing && existing.status !== "running") return undefined;
  }
  return makeTracker(reg, kind, paramsKey, params);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// Coerce an Express query object into a flat string map for the registry's stored
// `params` (used to rebuild the stream on reattach). Drops array/undefined values so
// a repeated `?k=a&k=b` can't smuggle an array in behind the `Record<string,string>`
// type. Mirrors what the insights controller does with its schema-typed query.
export function queryParams(q: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) if (typeof v === "string") out[k] = v;
  return out;
}

export function insightsParamsKey(q: Record<string, unknown>): string { return str(q.root); }
export function analyzeParamsKey(q: Record<string, unknown>): string { return str(q.root); }
export function rubricParamsKey(q: Record<string, unknown>): string {
  const scope = str(q.scope) || "project";
  return `${str(q.rubric)}:${scope}:${str(q.root)}:${str(q.sessionId)}`;
}
