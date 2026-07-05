// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWarmDaemon, runWarmCommand } from "../daemon.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

function fakeWatch() { let stopped = false; return Object.assign(() => ({ stop() { stopped = true; } }), { wasStopped: () => stopped }); }
// Never let a test start the REAL usage reporter — on a bound dev machine it would POST
// real usage rollups at the production aggregator.
function fakeReporter() { let stopped = false; let starts = 0; return Object.assign(() => { starts++; return { stop() { stopped = true; } }; }, { wasStopped: () => stopped, startCount: () => starts }); }

describe("startWarmDaemon", () => {
  it("runs the initial pass once, starts watcher + usage reporter, and blocks a second daemon via the pidfile", async () => {
    dir = mkdtempSync(join(tmpdir(), "dmn-"));
    let passes = 0;
    const watcher = fakeWatch();
    const reporter = fakeReporter();
    const first = startWarmDaemon({ home: dir, onLog: () => {}, watch: watcher, initialPass: async () => { passes++; }, usageReporter: reporter as never });
    expect(first).not.toBeNull();
    expect(passes).toBe(1);
    expect(reporter.startCount()).toBe(1);   // the daemon hosts the usage-report schedule
    const second = startWarmDaemon({ home: dir, onLog: () => {}, watch: () => ({ stop() {} }), initialPass: async () => { passes++; }, usageReporter: fakeReporter() as never });
    expect(second).toBeNull();               // pidfile held by first (our own live pid)
    await first!.stop();                      // releases pidfile
    expect(watcher.wasStopped()).toBe(true); // daemon.stop() must invoke the watcher's stop()
    expect(reporter.wasStopped()).toBe(true); // ...and the usage reporter's stop()
    const third = startWarmDaemon({ home: dir, onLog: () => {}, watch: () => ({ stop() {} }), initialPass: async () => { passes++; }, usageReporter: fakeReporter() as never });
    expect(third).not.toBeNull();             // free again
    await third!.stop();
  });
});

describe("runWarmCommand", () => {
  it("errors + exits(1) without --watch", () => {
    const codes: number[] = []; const errs: string[] = [];
    const d = runWarmCommand([], { exit: (c) => codes.push(c), errorLog: (m) => errs.push(m), start: () => { throw new Error("should not start"); }, log: () => {}, on: () => {} });
    expect(d).toBeNull();
    expect(codes).toEqual([1]);
    expect(errs[0]).toMatch(/--watch/);
  });
  it("with --watch: starts, logs, registers signal handlers", () => {
    const sigs: string[] = []; const logs: string[] = [];
    const handle = { stop: async () => {} };
    const d = runWarmCommand(["--watch"], { start: () => handle, log: (m) => logs.push(m), errorLog: () => {}, exit: () => {}, on: (s) => sigs.push(s) });
    expect(d).toBe(handle);
    expect(logs.some((l) => /watching/i.test(l))).toBe(true);
    expect(new Set(sigs)).toEqual(new Set(["SIGINT", "SIGTERM"]));
  });
  it("with --watch but another daemon live: exits(0)", () => {
    const codes: number[] = [];
    const d = runWarmCommand(["--watch"], { start: () => null, exit: (c) => codes.push(c), log: () => {}, errorLog: () => {}, on: () => {} });
    expect(d).toBeNull();
    expect(codes).toEqual([0]);
  });
});
