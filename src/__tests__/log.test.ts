// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { createLogger, onWarnOrError, maskSecret } from "@agentgem/base";

describe("createLogger", () => {
  it("exposes the five level loggers", () => {
    const log = createLogger("test");
    for (const level of ["error", "warn", "info", "debug", "trace"] as const) {
      expect(typeof log[level]).toBe("function");
    }
  });

  it("fires the warn/error hook with redacted args, and not for info", () => {
    const seen: { level: string; ns: string; args: unknown[] }[] = [];
    const dispose = onWarnOrError((ns: string, level: string, args: unknown[]) => {
      seen.push({ level, ns, args });
    });
    try {
      const log = createLogger("test");
      log.error("boom", { API_TOKEN: "sk-super-secret", keep: 1 });
      log.warn("careful");
      log.info("fyi", { API_TOKEN: "sk-should-not-hook" });

      // info does not reach the hook (hook fires for warn/error only)
      expect(seen.map((s) => s.level)).toEqual(["error", "warn"]);

      const err = seen[0];
      expect(err.ns).toContain("agentgem:test:error");
      // debug formats the message (prepending timestamp + namespace) into args[0];
      // trailing values stay separate — the secret-named key is masked before the
      // hook sees it, other keys survive.
      expect(String(err.args[0])).toContain("boom");
      expect(err.args[1]).toEqual({ API_TOKEN: "******", keep: 1 });
    } finally {
      dispose();
    }
  });
});

describe("maskSecret", () => {
  it("keeps a short fingerprint and hides the middle of a long secret", () => {
    const out = maskSecret("abcdefghijklmnopqrstuvwxyz");
    expect(out).toContain("...");
    expect(out).not.toContain("ghijkl");
    expect(out).toContain("len=26");
  });

  it("fully masks short values and reports empty", () => {
    expect(maskSecret("abcd")).toBe("****");
    expect(maskSecret("")).toBe("<empty>");
    expect(maskSecret(undefined)).toBe("<empty>");
  });
});
