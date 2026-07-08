// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/__tests__/nodeNotify.test.ts
import { describe, it, expect } from "vitest";
import { nodeNotify } from "../nodeNotify.js";

function rec() { const calls: { cmd: string; args: string[] }[] = []; return { exec: (cmd: string, args: string[]) => calls.push({ cmd, args }), calls }; }

describe("nodeNotify", () => {
  it("uses osascript with an AppleScript display-notification on darwin", () => {
    const r = rec();
    nodeNotify("Heads up", "context is heavy", r.exec, "darwin");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].cmd).toBe("osascript");
    expect(r.calls[0].args[0]).toBe("-e");
    expect(r.calls[0].args[1]).toContain("display notification");
    expect(r.calls[0].args[1]).toContain('"context is heavy"');
    expect(r.calls[0].args[1]).toContain('with title "Heads up"');
  });
  it("uses notify-send with argv (no shell) on linux", () => {
    const r = rec();
    nodeNotify("T", "B", r.exec, "linux");
    expect(r.calls[0]).toEqual({ cmd: "notify-send", args: ["T", "B"] });
  });
  it("is a no-op on other platforms", () => {
    const r = rec();
    nodeNotify("T", "B", r.exec, "win32");
    expect(r.calls).toHaveLength(0);
  });
  it("escapes quotes for AppleScript and strips newlines/control chars", () => {
    const r = rec();
    nodeNotify('a"b', "line1\nline2", r.exec, "darwin");
    expect(r.calls[0].args[1]).toContain('with title "a\\"b"');   // quote escaped
    expect(r.calls[0].args[1]).not.toContain("\n");                // newline stripped
  });
  it("passes shell metacharacters literally to notify-send argv (no injection)", () => {
    const r = rec();
    nodeNotify("T", "$(rm -rf ~); `whoami`", r.exec, "linux");
    expect(r.calls[0].args[1]).toBe("$(rm -rf ~); `whoami`");      // literal, argv not a shell string
  });
  it("never throws when exec throws", () => {
    const bomb = () => { throw new Error("no binary"); };
    expect(() => nodeNotify("T", "B", bomb, "linux")).not.toThrow();
  });
});
