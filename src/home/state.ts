// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/home/state.ts
//
// Persistence for the first-run "reveal" home screen's unlock/reveal-seen state. Follows the
// dream/store.ts JSON-in-HOME idiom: a small sidecar under <base>/.agentgem, best-effort writes
// (a write failure must never block the request — callers just don't get the persistence this
// time). Written to <base>/.agentgem/home-state.json, via writeJsonAtomic (temp file + rename)
// so a crash mid-write can't leave truncated/corrupt JSON behind in the first place.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { agentgemHome, writeJsonAtomic } from "@agentgem/model";
import { configPath as shareConfigPath } from "../agentgemConfig.js";

export interface HomeState {
  unlockedAt?: number;
  firstSeenVersion?: string;
  existingUser?: boolean;
  revealSeenAt?: number;
}

function stateDir(base: string): string {
  return join(base, ".agentgem");
}
function statePath(base: string): string {
  return join(stateDir(base), "home-state.json");
}

// AGENTGEM_HOME artifacts that predate this feature. Their presence means the reveal's
// "first run" framing would be a lie for this user, so existingUser latches true forever —
// checked ONLY on the very first read (see readState), never re-derived afterward.
const PREEXISTING_ARTIFACT_NAMES = [
  "transcript-index.db",           // recall/observe scan index (packages/capture/transcriptIndex.ts)
  "global-usage-cache.json",       // warm-precompute cache (packages/capture/usageCache.ts)
  "analysis-cache.json",           // warm-precompute cache (packages/insight/analysisCache.ts)
  "insights-cache.json",           // warm-precompute cache (packages/insight/insightsCache.ts)
  "session-dashboard-cache.json",  // warm-precompute cache (packages/insight/dashboardCache.ts)
]; // all live under <base>/.agentgem/<name> — same base as this file's own home-state.json

function hasPreexistingArtifacts(base: string): boolean {
  if (PREEXISTING_ARTIFACT_NAMES.some((name) => existsSync(join(stateDir(base), name)))) return true;
  // config.json is written by src/agentgemConfig.ts against os.homedir() directly — NOT
  // agentgemHome() — so check the exact path that module writes rather than assuming it
  // lives under `base` (they only coincide when AGENTGEM_HOME is unset).
  return existsSync(shareConfigPath());
}

function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/home/state.js -> ../../package.json is the repo root.
    return JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function computeInitialState(base: string): HomeState {
  return { existingUser: hasPreexistingArtifacts(base), firstSeenVersion: packageVersion() };
}

// Read persisted state. On first read (file absent) OR on a corrupt file (unparseable JSON —
// e.g. a torn write from a crash), re-run the first-read derivation and persist the repaired
// state immediately, rather than silently falling back to `{}`: an empty object reads as
// locked-fresh, which would revert a previously-latched existingUser/unlocked user and violate
// the one-way unlock invariant. Recomputing from the artifacts (still on disk) self-heals for
// anyone whose existingUser/gems-exist condition still holds.
export function readState(base: string = agentgemHome()): HomeState {
  const path = statePath(base);
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as HomeState;
    } catch {
      const repaired = computeInitialState(base);
      writeJsonAtomic(path, repaired);
      return repaired;
    }
  }
  const initial = computeInitialState(base);
  writeJsonAtomic(path, initial);
  return initial;
}

// Latch the one-way unlock: no-op if already set (so it never reverts and never bumps the
// timestamp on repeat calls).
export function persistUnlock(state: HomeState, base: string = agentgemHome()): HomeState {
  if (state.unlockedAt) return state;
  const next: HomeState = { ...state, unlockedAt: Date.now() };
  writeJsonAtomic(statePath(base), next);
  return next;
}

// Latch reveal-seen: same one-way, idempotent semantics as persistUnlock.
export function persistRevealSeen(state: HomeState, base: string = agentgemHome()): HomeState {
  if (state.revealSeenAt) return state;
  const next: HomeState = { ...state, revealSeenAt: Date.now() };
  writeJsonAtomic(statePath(base), next);
  return next;
}
