// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { startWarmSchedule } from "../schedule.js";

describe("startWarmSchedule", () => {
  it("runs once immediately and again on each interval tick, and stop() clears the timer", () => {
    let runs = 0;
    let tick: (() => void) | null = null;
    let cleared = false;
    const sched = startWarmSchedule({
      intervalMs: 1000,
      run: async () => { runs++; },
      runNow: (fn) => fn(),                       // synchronous "boot" run
      setInterval: (fn) => { tick = fn; return {}; },
      clearInterval: () => { cleared = true; },
    });
    expect(runs).toBe(1);        // boot pass
    tick!(); tick!();            // two idle ticks
    expect(runs).toBe(3);
    sched.stop();
    expect(cleared).toBe(true);
  });
});

describe("startWarmSchedule – AGENTGEM_WARM_INTERVAL_MS env override", () => {
  const KEY = "AGENTGEM_WARM_INTERVAL_MS";
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("env='2000' with no explicit intervalMs → passes 2000 to setInterval", () => {
    process.env[KEY] = "2000";
    let capturedMs: number | undefined;
    startWarmSchedule({
      run: async () => {},
      runNow: () => {},  // skip boot run
      setInterval: (fn, ms) => { capturedMs = ms; return {}; },
      clearInterval: () => {},
    });
    expect(capturedMs).toBe(2000);
  });

  it("explicit opts.intervalMs overrides env", () => {
    process.env[KEY] = "2000";
    let capturedMs: number | undefined;
    startWarmSchedule({
      intervalMs: 5000,   // explicit wins
      run: async () => {},
      runNow: () => {},
      setInterval: (fn, ms) => { capturedMs = ms; return {}; },
      clearInterval: () => {},
    });
    expect(capturedMs).toBe(5000);
  });

  it("invalid env ('bad') → falls back to DEFAULT_INTERVAL_MS (600000)", () => {
    process.env[KEY] = "bad";
    let capturedMs: number | undefined;
    startWarmSchedule({
      run: async () => {},
      runNow: () => {},
      setInterval: (fn, ms) => { capturedMs = ms; return {}; },
      clearInterval: () => {},
    });
    expect(capturedMs).toBe(10 * 60 * 1000);
  });

  it("env='500' (< 1000) → falls back to DEFAULT_INTERVAL_MS", () => {
    process.env[KEY] = "500";
    let capturedMs: number | undefined;
    startWarmSchedule({
      run: async () => {},
      runNow: () => {},
      setInterval: (fn, ms) => { capturedMs = ms; return {}; },
      clearInterval: () => {},
    });
    expect(capturedMs).toBe(10 * 60 * 1000);
  });
});
