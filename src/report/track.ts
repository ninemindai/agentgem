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

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function insightsParamsKey(q: Record<string, unknown>): string { return str(q.root); }
export function analyzeParamsKey(q: Record<string, unknown>): string { return str(q.root); }
export function rubricParamsKey(q: Record<string, unknown>): string {
  const scope = str(q.scope) || "project";
  return `${str(q.rubric)}:${scope}:${str(q.root)}:${str(q.sessionId)}`;
}
