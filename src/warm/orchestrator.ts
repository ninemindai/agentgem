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

export type WarmItemStatus = "warmed" | "hit" | "skipped" | "error";
export interface WarmOutcome { id: string; root: string | null; status: WarmItemStatus }
export interface WarmPassResult { startedAt: number; finishedAt: number; outcomes: WarmOutcome[] }
export interface WarmStatus { running: boolean; last: WarmPassResult | null }

const DEFAULT_TOP_N = 5;

// Foreground gate: incremented while a user-facing LLM compute (insights/analyze
// SSE endpoint) is in flight, so background warms yield the agent to the user.
let foreground = 0;
export function beginForeground(): void { foreground++; }
export function endForeground(): void { foreground = Math.max(0, foreground - 1); }
export function isForegroundBusy(): boolean { return foreground > 0; }

let status: WarmStatus = { running: false, last: null };
export function getWarmStatus(): WarmStatus { return status; }

export async function runWarmPass(opts: {
  dir?: string; roots?: string[]; force?: boolean; topN?: number;
  now?: () => number; registry?: Warmable[]; isBusy?: () => boolean; home?: string;
} = {}): Promise<WarmPassResult> {
  const now = opts.now ?? Date.now;
  const registry = opts.registry ?? WARMABLES;
  const isBusy = opts.isBusy ?? isForegroundBusy;
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const roots = opts.roots
    ?? readRecents(opts.home ?? agentgemHome()).map((r) => r.path);
  const llmRoots = roots.slice(0, topN);

  status = { running: true, last: status.last };
  const startedAt = now();
  const outcomes: WarmOutcome[] = [];

  for (const w of registry) {
    if (w.scope === "global") {
      outcomes.push(await runOne(w, null, opts));
    } else {
      for (const root of llmRoots) {
        if (w.cost === "llm" && isBusy()) { outcomes.push({ id: w.id, root, status: "skipped" }); continue; }
        outcomes.push(await runOne(w, root, opts));   // serial: await each before the next
      }
    }
  }

  const result: WarmPassResult = { startedAt, finishedAt: now(), outcomes };
  status = { running: false, last: result };
  return result;
}

async function runOne(w: Warmable, root: string | null, opts: { dir?: string; force?: boolean }): Promise<WarmOutcome> {
  try {
    const s = await w.warm(root, { dir: opts.dir, force: opts.force });
    return { id: w.id, root, status: s };
  } catch (err) {
    console.error(`[warm] ${w.id} ${root ?? "(global)"} failed:`, err);
    return { id: w.id, root, status: "error" };
  }
}
