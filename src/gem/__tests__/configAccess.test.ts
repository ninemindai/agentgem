// src/gem/__tests__/configAccess.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { claudeJsonPath, sensitiveConfigPaths, configWriteAccess } from "@agentgem/run";

describe("claudeJsonPath", () => {
  it("reads $CLAUDE_CONFIG_DIR/.claude.json when CLAUDE_CONFIG_DIR is set", () => {
    expect(claudeJsonPath({ CLAUDE_CONFIG_DIR: "/cfg" }, "/Users/x")).toBe(join("/cfg", ".claude.json"));
  });
  it("falls back to ~/.claude.json (in HOME, a sibling of ~/.claude) otherwise", () => {
    expect(claudeJsonPath({}, "/Users/x")).toBe(join("/Users/x", ".claude.json"));
  });
});

describe("sensitiveConfigPaths", () => {
  it("covers the host code-exec / credential-theft vectors with their file/dir kind", () => {
    const s = sensitiveConfigPaths("/cfg");
    expect(s).toEqual([
      { path: join("/cfg", "settings.json"), kind: "file" },
      { path: join("/cfg", "settings.local.json"), kind: "file" },
      { path: join("/cfg", ".credentials.json"), kind: "file" },
      { path: join("/cfg", "skills"), kind: "dir" },
      { path: join("/cfg", "plugins"), kind: "dir" },
    ]);
  });
});

describe("configWriteAccess", () => {
  it("makes the real config dir + .claude.json writable but the sensitive paths denied", () => {
    const a = configWriteAccess("/cfg", {}, "/Users/x");
    expect(a.writable).toEqual(["/cfg", join("/Users/x", ".claude.json")]);
    expect(a.denied).toEqual(sensitiveConfigPaths("/cfg"));
  });

  it("a sensitive path is never also writable (deny must win at the policy layer)", () => {
    const a = configWriteAccess("/cfg", {}, "/Users/x");
    const writable = new Set(a.writable);
    for (const d of a.denied) expect(writable.has(d.path)).toBe(false);
  });
});
