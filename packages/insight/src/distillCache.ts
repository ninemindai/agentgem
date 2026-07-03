// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/distillCache.ts
//
// Per-project cache of the (expensive, LLM) playbook distillation (skills +
// session lessons). Separate file (distill-cache.json) + own token version so it
// evicts and versions independently from insights/analysis. Best-effort; never throws.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { agentgemHome, writeJsonAtomic } from "@agentgem/model";

const MAX_ENTRIES = 50;
function cachePath(): string { return join(agentgemHome(), ".agentgem", "distill-cache.json"); }

// d2 = d1 + optional DistilledSkill.triggerContract.
const TOKEN_VERSION = "d2";

/** version + transcript count + newest mtime — a new/updated session yields a new token. */
export function distillToken(paths: string[]): string {
  let maxMs = 0;
  for (const p of paths) { try { const m = statSync(p).mtimeMs; if (m > maxMs) maxMs = m; } catch { /* gone */ } }
  return `${TOKEN_VERSION}:${paths.length}:${Math.round(maxMs)}`;
}

interface Entry { root: string; token: string; result: unknown; ts: number }
function readAll(): Entry[] {
  try { const j = JSON.parse(readFileSync(cachePath(), "utf8")); return Array.isArray(j) ? j : []; } catch { return []; }
}

export function readDistillCache(root: string, token: string): unknown | null {
  const e = readAll().find((x) => x.root === root && x.token === token);
  return e ? e.result : null;
}

export function readDistillCacheEntry(root: string, token: string): { result: unknown; ts: number } | null {
  const e = readAll().find((x) => x.root === root && x.token === token);
  return e ? { result: e.result, ts: e.ts } : null;
}

export function writeDistillCache(root: string, token: string, result: unknown, nowMs: number): void {
  try {
    const all = readAll().filter((x) => x.root !== root);
    all.push({ root, token, result, ts: nowMs });
    all.sort((a, b) => b.ts - a.ts);
    writeJsonAtomic(cachePath(), all.slice(0, MAX_ENTRIES));
  } catch { /* best-effort */ }
}
