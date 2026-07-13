// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// In-memory tracker of agent-backed report runs (insights | rubric | analyze).
// The existing SSE routes drive it (begin/phase/finish); it exists only to power
// the activity view + notify-on-done and to let a returning panel discover a run.
// The RESULT is never stored here — the compute cores' own cache holds it, and a
// reattaching panel re-opens the existing stream (a cache hit) to load it.
import { createLogger } from "@agentgem/base";
import { BindingKey } from "@agentback/core";

const log = createLogger("report-registry");

export type RunStatus = "running" | "done" | "failed";

export interface RunRecord {
  kind: string;
  paramsKey: string;
  params: Record<string, string>;   // the route query, so a reattach can rebuild the stream
  status: RunStatus;
  phase: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface RunSummary extends RunRecord { id: string }

export class ReportRegistry {
  private runs = new Map<string, RunRecord>();   // key = `${kind}:${paramsKey}`
  private now: () => number;
  private ttlMs: number;
  private maxDone: number;

  constructor(opts: { now?: () => number; ttlMs?: number; maxDone?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 30 * 60_000;
    this.maxDone = opts.maxDone ?? 50;
  }

  private key(kind: string, paramsKey: string): string { return `${kind}:${paramsKey}`; }

  begin(kind: string, paramsKey: string, params: Record<string, string>): void {
    this.runs.set(this.key(kind, paramsKey), { kind, paramsKey, params, status: "running", phase: "starting", startedAt: this.now(), finishedAt: undefined });
  }

  phase(kind: string, paramsKey: string, phase: string): void {
    const r = this.runs.get(this.key(kind, paramsKey));
    if (r && r.status === "running") r.phase = phase;
  }

  finish(kind: string, paramsKey: string, status: "done" | "failed", error?: string): void {
    const r = this.runs.get(this.key(kind, paramsKey));
    if (!r) return;
    r.status = status; r.finishedAt = this.now();
    if (status === "done") r.phase = "done";
    if (error) r.error = error;
  }

  get(kind: string, paramsKey: string): RunRecord | undefined { return this.runs.get(this.key(kind, paramsKey)); }

  list(): RunSummary[] {
    return [...this.runs.entries()]
      .map(([id, r]) => ({ id, ...r }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, r] of this.runs) {
      if (r.status !== "running" && r.finishedAt != null && r.finishedAt < cutoff) this.runs.delete(id);
    }
    const finished = [...this.runs.entries()]
      .filter(([, r]) => r.status !== "running")
      .sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0));
    while (finished.length > this.maxDone) this.runs.delete(finished.shift()![0]);
    log.debug("swept; %d runs retained", this.runs.size);
  }
}

// DI key so a decorator controller (InsightsController) can share the ONE
// registry instance the raw analyze/rubric routes + /api/report/runs use. Bound
// in finalizeCommonApp; injected `{optional:true}` so tests/non-tracking paths work.
export const REPORT_REGISTRY = BindingKey.create<ReportRegistry>("agentgem.report.registry");
