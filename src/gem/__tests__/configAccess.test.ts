// src/gem/__tests__/configAccess.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { claudeJsonPath, sensitiveConfigPaths, configWriteAccess } from "../configAccess.js";

describe("claudeJsonPath", () => {
  it("reads $CLAUDE_CONFIG_DIR/.claude.json when CLAUDE_CONFIG_DIR is set", () => {
    expect(claudeJsonPath({ CLAUDE_CONFIG_DIR: "/cfg" }, "/Users/x")).toBe(join("/cfg", ".claude.json"));
  });
  it("falls back to ~/.claude.json (in HOME, a sibling of ~/.claude) otherwise", () => {
    expect(claudeJsonPath({}, "/Users/x")).toBe(join("/Users/x", ".claude.json"));
  });
});

describe("sensitiveConfigPaths", () => {
  it("covers the host code-exec / credential-theft vectors under the config dir", () => {
    const s = sensitiveConfigPaths("/cfg");
    expect(s).toEqual([
      join("/cfg", "settings.json"),
      join("/cfg", "settings.local.json"),
      join("/cfg", ".credentials.json"),
      join("/cfg", "skills"),
      join("/cfg", "plugins"),
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
    for (const d of a.denied) expect(a.writable).not.toContain(d);
  });
});
