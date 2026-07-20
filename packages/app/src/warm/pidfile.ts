// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/pidfile.ts
//
// Best-effort singleton lock for the warm daemon. acquirePidfile writes the
// current pid unless a *live* pid already holds the file; a stale pid (dead
// process) is overwritten. Never throws.
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function acquirePidfile(path: string): boolean {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return false;   // live holder
  } catch { /* no/unreadable file → treat as free */ }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(process.pid), "utf8");
    return true;
  } catch { return false; }
}

export function releasePidfile(path: string): void {
  try { unlinkSync(path); } catch { /* ignore */ }
}
