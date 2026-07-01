// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/model/src/atomicWrite.ts
//
// Atomic JSON write: serialize to a per-process temp file in the same directory,
// then rename() over the target (atomic on one filesystem). Two processes writing
// the same cache never corrupt it — each uses a distinct temp path and the final
// rename is atomic; last writer wins. Best-effort: failures never throw.
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function writeJsonAtomic(path: string, data: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;   // per-process temp avoids cross-process collision
    writeFileSync(tmp, JSON.stringify(data), "utf8");
    renameSync(tmp, path);
  } catch { /* best-effort */ }
}
