// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/schedule.ts
//
// Trigger A: fire one warm pass shortly after boot, then re-run on a low-freq
// idle timer. Cheap because unchanged transcript tokens short-circuit inside the
// warmables. Timer + runner are injectable for tests. A future daemon (Trigger C)
// can drive runWarmPass directly and ignore this module.
import { agentgemHome } from "@agentgem/model";
import { runWarmPass } from "./orchestrator.js";
import { withWarmLock } from "./lock.js";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes; override with AGENTGEM_WARM_INTERVAL_MS env var

function intervalFromEnv(): number | undefined {
  const v = parseInt(process.env.AGENTGEM_WARM_INTERVAL_MS ?? "", 10);
  return Number.isFinite(v) && v >= 1000 ? v : undefined;
}

// Set AGENTGEM_WARM_DISABLE=true to turn warming off entirely: no boot pass and
// no idle timer. Use on memory-constrained hosts — a warm pass's transient
// working set (transcript parsing) spikes RSS well above the idle footprint.
// Endpoints still compute on demand; they're just not pre-warmed.
function warmDisabled(): boolean {
  return process.env.AGENTGEM_WARM_DISABLE === "true";
}

export interface WarmSchedule { stop(): void }

export function startWarmSchedule(opts: {
  home?: string;
  intervalMs?: number;
  run?: () => Promise<unknown>;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (h: unknown) => void;
  runNow?: (fn: () => void) => void;
} = {}): WarmSchedule {
  if (warmDisabled()) return { stop() {} };
  const home = opts.home ?? agentgemHome();
  const intervalMs = opts.intervalMs ?? intervalFromEnv() ?? DEFAULT_INTERVAL_MS;
  const run = opts.run ?? (() => withWarmLock(home, () => runWarmPass(), () => undefined));
  const setI = opts.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearI = opts.clearInterval ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>));
  // Default boot run is deferred a tick so it never blocks the caller (server boot).
  const runNow = opts.runNow ?? ((fn) => { setTimeout(fn, 0); });

  const fire = () => { void run(); };
  runNow(fire);
  const handle = setI(fire, intervalMs);
  handle?.unref?.();   // don't keep the process alive just for warming

  return { stop() { clearI(handle); } };
}
