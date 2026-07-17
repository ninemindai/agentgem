// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/home/state.ts
//
// Persistence for the first-run "reveal" home screen's unlock/reveal-seen state. Follows the
// dream/store.ts JSON-in-HOME idiom: a small sidecar under <base>/.agentgem, best-effort writes
// (a write failure must never block the request — callers just don't get the persistence this
// time). Written to <base>/.agentgem/home-state.json.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { agentgemHome } from "@agentgem/model";
import { createLogger } from "@agentgem/base";

const log = createLogger("home");

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
function writeState(base: string, value: HomeState): boolean {
  try {
    mkdirSync(stateDir(base), { recursive: true });
    writeFileSync(statePath(base), JSON.stringify(value, null, 2), "utf8");
    return true;
  } catch (err) {
    log.warn("home-state write failed (ignored): %s", (err as Error)?.message ?? err);
    return false;
  }
}

// AGENTGEM_HOME artifacts that predate this feature. Their presence means the reveal's
// "first run" framing would be a lie for this user, so existingUser latches true forever —
// checked ONLY on the very first read (see readState), never re-derived afterward.
const PREEXISTING_ARTIFACTS = [
  "transcript-index.db",           // recall/observe scan index (packages/capture/transcriptIndex.ts)
  "config.json",                   // share-adoption config (src/agentgemConfig.ts)
  "global-usage-cache.json",       // warm-precompute cache (packages/capture/usageCache.ts)
  "analysis-cache.json",           // warm-precompute cache (packages/insight/analysisCache.ts)
  "insights-cache.json",           // warm-precompute cache (packages/insight/insightsCache.ts)
  "session-dashboard-cache.json",  // warm-precompute cache (packages/insight/dashboardCache.ts)
];

function hasPreexistingArtifacts(base: string): boolean {
  return PREEXISTING_ARTIFACTS.some((name) => existsSync(join(stateDir(base), name)));
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

// Read persisted state. On first read (file absent), compute existingUser + firstSeenVersion
// ONCE and persist that computation immediately, so a later write to one of the
// PREEXISTING_ARTIFACTS files (e.g. a scan cache warmed by this very request) never
// retroactively flips existingUser for a genuinely-new user.
export function readState(base: string = agentgemHome()): HomeState {
  const path = statePath(base);
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as HomeState;
    } catch {
      return {};
    }
  }
  const initial: HomeState = { existingUser: hasPreexistingArtifacts(base), firstSeenVersion: packageVersion() };
  writeState(base, initial);
  return initial;
}

// Latch the one-way unlock: no-op if already set (so it never reverts and never bumps the
// timestamp on repeat calls).
export function persistUnlock(state: HomeState, base: string = agentgemHome()): HomeState {
  if (state.unlockedAt) return state;
  const next: HomeState = { ...state, unlockedAt: Date.now() };
  writeState(base, next);
  return next;
}

// Latch reveal-seen: same one-way, idempotent semantics as persistUnlock.
export function persistRevealSeen(state: HomeState, base: string = agentgemHome()): HomeState {
  if (state.revealSeenAt) return state;
  const next: HomeState = { ...state, revealSeenAt: Date.now() };
  writeState(base, next);
  return next;
}
