// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { launchdPlist, systemdUnit, installService, uninstallService, runServiceCommand, UnsupportedPlatformError } from "../service.js";

const EXEC = ["/usr/bin/node", "/app/dist/cli.js", "warm", "--watch"];

describe("service generators", () => {
  it("launchdPlist embeds the exec args and RunAtLoad", () => {
    const p = launchdPlist(EXEC, "ai.ninemind.agentgem.warm");
    for (const a of EXEC) expect(p).toContain(a);
    expect(p).toContain("RunAtLoad");
    expect(p).toContain("ai.ninemind.agentgem.warm");
  });
  it("systemdUnit embeds ExecStart and WantedBy", () => {
    const u = systemdUnit(EXEC);
    expect(u).toContain(EXEC.join(" "));
    expect(u).toContain("WantedBy=default.target");
  });
});

describe("installService", () => {
  it("writes the plist under LaunchAgents on darwin and returns the load command", () => {
    const writes: Array<{ p: string; c: string }> = []; const mkdirs: string[] = [];
    const r = installService({ platform: "darwin", home: "/h", exec: EXEC, writeFile: (p, c) => writes.push({ p, c }), mkdir: (p) => mkdirs.push(p), unlink: () => {} });
    expect(r.path).toBe("/h/Library/LaunchAgents/ai.ninemind.agentgem.warm.plist");
    expect(writes[0].p).toBe(r.path);
    expect(r.loadCmd).toContain("launchctl");
  });
  it("writes the unit under systemd/user on linux", () => {
    const writes: Array<{ p: string; c: string }> = [];
    const r = installService({ platform: "linux", home: "/h", exec: EXEC, writeFile: (p, c) => writes.push({ p, c }), mkdir: () => {}, unlink: () => {} });
    expect(r.path).toBe("/h/.config/systemd/user/agentgem-warm.service");
    expect(r.loadCmd).toContain("systemctl --user");
  });
  it("throws UnsupportedPlatformError on win32", () => {
    expect(() => installService({ platform: "win32", home: "/h", exec: EXEC, writeFile: () => {}, mkdir: () => {}, unlink: () => {} })).toThrow(UnsupportedPlatformError);
  });
});

describe("runServiceCommand", () => {
  it("--install-service installs and logs; --uninstall-service uninstalls", () => {
    const logs: string[] = [];
    runServiceCommand(["--install-service"], { install: () => ({ path: "/x", loadCmd: "load me" }), uninstall: () => ({ path: "/x", removed: true }), log: (m) => logs.push(m), errorLog: () => {}, exit: () => {} });
    expect(logs.join("\n")).toContain("load me");
    const logs2: string[] = [];
    runServiceCommand(["--uninstall-service"], { install: () => ({ path: "/x", loadCmd: "" }), uninstall: () => ({ path: "/x", removed: true }), log: (m) => logs2.push(m), errorLog: () => {}, exit: () => {} });
    expect(logs2.join("\n")).toMatch(/remov/i);
  });
  it("unsupported platform → errorLog + exit(1)", () => {
    const codes: number[] = []; const errs: string[] = [];
    runServiceCommand(["--install-service"], { install: () => { throw new UnsupportedPlatformError("nope"); }, uninstall: () => ({ path: "", removed: false }), log: () => {}, errorLog: (m) => errs.push(m), exit: (c) => codes.push(c) });
    expect(codes).toEqual([1]); expect(errs.length).toBe(1);
  });
});
