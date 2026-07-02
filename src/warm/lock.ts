// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/lock.ts
//
// Cross-process advisory lock for a warm pass: a lockfile is just a pidfile with
// a different name, so this reuses acquirePidfile/releasePidfile (stale-tolerant
// liveness). If a *live* holder exists, the caller's onSkip() runs instead — the
// cross-process complement to runWarmPass's in-process re-entrancy guard.
// Opt out with AGENTGEM_WARM_LOCK=false. Best-effort.
import { join } from "node:path";
import { acquirePidfile, releasePidfile } from "./pidfile.js";

export async function withWarmLock<T>(
  home: string,
  fn: () => Promise<T>,
  onSkip: () => T,
  deps: { acquire?: (p: string) => boolean; release?: (p: string) => void; enabled?: boolean } = {},
): Promise<T> {
  const enabled = deps.enabled ?? (process.env.AGENTGEM_WARM_LOCK !== "false");
  if (!enabled) return fn();
  const acquire = deps.acquire ?? acquirePidfile;
  const release = deps.release ?? releasePidfile;
  const lockPath = join(home, ".agentgem", "warm-pass.lock");
  if (!acquire(lockPath)) return onSkip();
  try { return await fn(); } finally { release(lockPath); }
}
