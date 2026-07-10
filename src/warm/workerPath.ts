// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/workerPath.ts
//
// Resolving a worker entry by `new URL("./x.js", import.meta.url)` is a trap here.
// scripts/bundle-bins.mjs bundles `dist/index.js`, and index.js imports
// startWarmSchedule -> warm/registry.js, so esbuild INLINES registry into
// dist/index.js and rewrites its import.meta.url from dist/warm/ to dist/. The
// naive relative URL then points at dist/scorecardWorker.js, which does not exist:
// works from source, dies in the published tarball. (Same class of bug the
// bundler's own `externalFor` comment calls out for cli.js's isMain guard.)
//
// So probe both layouts and pick the one that is actually on disk. `baseUrl` is a
// parameter, not a hard-coded import.meta.url, so each layout is directly testable.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Loose tsc output (dist/warm/registry.js) first, then the bundled layout (dist/index.js). */
export const WORKER_CANDIDATES = ["./scorecardWorker.js", "./warm/scorecardWorker.js"] as const;

/** Absolute path to the worker entry, or null when neither layout has it (run inline). */
export function resolveWorkerPath(baseUrl: string, candidates: readonly string[] = WORKER_CANDIDATES): string | null {
  for (const rel of candidates) {
    try {
      const p = fileURLToPath(new URL(rel, baseUrl));
      if (existsSync(p)) return p;
    } catch { /* a malformed base URL just means "not this candidate" */ }
  }
  return null;
}
