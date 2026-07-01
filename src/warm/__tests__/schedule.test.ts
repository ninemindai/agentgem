// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
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
