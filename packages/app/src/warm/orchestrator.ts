// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/orchestrator.ts
//
// The single warming engine. Trigger-agnostic: the in-process schedule (now) and
// a future daemon (later) both call runWarmPass. Global warmables run once; LLM
// per-root warmables run for the top-N most-recently-active projects, serially,
// and are skipped while a foreground compute is in flight. Best-effort throughout.
import { agentgemHome } from "@agentgem/model";
import { readRecents } from "@agentgem/capture";
import { WARMABLES, type Warmable } from "./registry.js";
import { createLogger } from "@agentgem/base";
import { basename } from "node:path";

const log = createLogger("warm");

export type WarmItemStatus = "warmed" | "hit" | "skipped" | "error";
export interface WarmOutcome { id: string; root: string | null; status: WarmItemStatus }
export interface WarmPassResult { startedAt: number; finishedAt: number; outcomes: WarmOutcome[] }

// Phase mapping for the sleep-cycle UI (single source of truth; the dream
// controller imports this). Unmapped warmables (observe/recall/distill/dream)
// have no phase.
export const PHASE_OF: Record<string, "LIGHT" | "DEEP" | "REM"> = {
  usage: "LIGHT", scorecard: "LIGHT", analyze: "DEEP", insights: "REM",
};

// Live, incremental view of the in-flight pass (null when idle). Updated at
// warmable boundaries — a synchronous scan blocks the loop, so the tracker
// advances between steps, not continuously.
export interface WarmProgress {
  startedAt: number;
  phase: "LIGHT" | "DEEP" | "REM" | null;      // phase of the currently-running warmable
  phasesLit: Array<"LIGHT" | "DEEP" | "REM">;  // phases with ≥1 warmed/hit so far
  currentRoot: string | null;                  // display basename of the project (null for global steps)
  rootIndex: number;                           // 1-based within the current per-root warmable (0 for global)
  rootCount: number;                           // number of selected projects
  done: number;                                // steps completed
  total: number;                               // total steps this pass
}
export interface WarmStatus { running: boolean; last: WarmPassResult | null; progress: WarmProgress | null }

const DEFAULT_TOP_N = 5; // override with AGENTGEM_WARM_TOPN env var

function topNFromEnv(): number | undefined {
  const v = parseInt(process.env.AGENTGEM_WARM_TOPN ?? "", 10);
  return Number.isFinite(v) && v >= 1 ? v : undefined;
}

// Foreground gate: incremented while a user-facing LLM compute (insights/analyze
// SSE endpoint) is in flight, so background warms yield the agent to the user.
let foreground = 0;
export function beginForeground(): void { foreground++; }
export function endForeground(): void { foreground = Math.max(0, foreground - 1); }
export function isForegroundBusy(): boolean { return foreground > 0; }

let status: WarmStatus = { running: false, last: null, progress: null };
export function getWarmStatus(): WarmStatus { return status; }

export async function runWarmPass(opts: {
  dir?: string; roots?: string[]; force?: boolean; topN?: number;
  now?: () => number; registry?: Warmable[]; isBusy?: () => boolean; home?: string;
  cheapOnly?: boolean;
} = {}): Promise<WarmPassResult> {
  const now = opts.now ?? Date.now;
  // Re-entrancy guard: a pass already in flight (e.g. an idle tick firing while
  // the previous pass is still warming) must not overlap — overlapping passes
  // corrupt `status` and double the LLM work. Bail with the last known result.
  if (status.running) return status.last ?? { startedAt: now(), finishedAt: now(), outcomes: [] };
  // cheapOnly (used by the boot pass) restricts to the cheap global caches — the ones
  // the first screens block on — so a fresh server serves first paint fast instead of
  // stalling behind the per-root LLM warmables, whose synchronous scans block the event
  // loop for minutes. Those still run on the idle ticks (full pass), gated by isBusy.
  const registry = (opts.registry ?? WARMABLES).filter((w) => !opts.cheapOnly || (w.cost === "cheap" && w.scope === "global"));
  const isBusy = opts.isBusy ?? isForegroundBusy;
  const topN = opts.topN ?? topNFromEnv() ?? DEFAULT_TOP_N;
  const roots = opts.roots
    ?? readRecents(opts.home ?? agentgemHome()).map((r) => r.path);
  const selectedRoots = roots.slice(0, topN);

  const startedAt = now();
  const outcomes: WarmOutcome[] = [];
  const phasesLit = new Set<"LIGHT" | "DEEP" | "REM">();
  const globalCount = registry.filter((w) => w.scope === "global").length;
  const total = globalCount + (registry.length - globalCount) * selectedRoots.length;
  let progress: WarmProgress = {
    startedAt, phase: null, phasesLit: [], currentRoot: null,
    rootIndex: 0, rootCount: selectedRoots.length, done: 0, total,
  };
  status = { running: true, last: status.last, progress };

  // Publish a fresh snapshot BEFORE a step (so pollers see the running warmable)
  // and AFTER (so `done`/`phasesLit` advance once it finishes).
  const beginStep = (w: Warmable, root: string | null, rootIndex: number): void => {
    progress = { ...progress, phase: PHASE_OF[w.id] ?? null, currentRoot: root ? basename(root) : null, rootIndex };
    status = { running: true, last: status.last, progress };
  };
  const endStep = (w: Warmable, outcome: WarmOutcome): void => {
    if ((outcome.status === "warmed" || outcome.status === "hit") && PHASE_OF[w.id]) phasesLit.add(PHASE_OF[w.id]);
    progress = { ...progress, done: progress.done + 1, phasesLit: [...phasesLit] };
    status = { running: true, last: status.last, progress };
  };

  for (const w of registry) {
    if (w.scope === "global") {
      beginStep(w, null, 0);
      const outcome = await runOne(w, null, opts);
      outcomes.push(outcome);
      endStep(w, outcome);
    } else {
      for (let i = 0; i < selectedRoots.length; i++) {
        const root = selectedRoots[i];
        beginStep(w, root, i + 1);
        const outcome = w.cost === "llm" && isBusy()
          ? { id: w.id, root, status: "skipped" as const }
          : await runOne(w, root, opts);   // serial: await each before the next
        outcomes.push(outcome);
        endStep(w, outcome);
      }
    }
  }

  const result: WarmPassResult = { startedAt, finishedAt: now(), outcomes };
  status = { running: false, last: result, progress: null };
  return result;
}

async function runOne(w: Warmable, root: string | null, opts: { dir?: string; force?: boolean }): Promise<WarmOutcome> {
  try {
    const s = await w.warm(root, { dir: opts.dir, force: opts.force });
    return { id: w.id, root, status: s };
  } catch (err) {
    log.error("[warm] %s %s failed: %s", w.id, root ?? "(global)", (err as Error)?.message ?? err);
    return { id: w.id, root, status: "error" };
  }
}
