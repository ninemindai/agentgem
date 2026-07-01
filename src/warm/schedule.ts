// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/schedule.ts
//
// Trigger A: fire one warm pass shortly after boot, then re-run on a low-freq
// idle timer. Cheap because unchanged transcript tokens short-circuit inside the
// warmables. Timer + runner are injectable for tests. A future daemon (Trigger C)
// can drive runWarmPass directly and ignore this module.
import { runWarmPass } from "./orchestrator.js";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes

export interface WarmSchedule { stop(): void }

export function startWarmSchedule(opts: {
  intervalMs?: number;
  run?: () => Promise<unknown>;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (h: unknown) => void;
  runNow?: (fn: () => void) => void;
} = {}): WarmSchedule {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const run = opts.run ?? (() => runWarmPass());
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
