// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/play/__tests__/mcpDigest.test.ts
import { describe, it, expect } from "vitest";
import { mcpServerConfigDigest } from "@agentgem/play";

const gem = (config: Record<string, unknown>) => ({ type: "mcp_server" as const, name: "github", transport: "stdio" as const, config, source: "user" });

describe("mcpServerConfigDigest", () => {
  it("is stable across key order (deterministic canonicalization)", () => {
    const a = mcpServerConfigDigest(gem({ command: "gh-mcp", args: ["--x"], env: { A: "1", B: "2" } }));
    const b = mcpServerConfigDigest(gem({ env: { B: "2", A: "1" }, args: ["--x"], command: "gh-mcp" }));
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is STABLE across a secret VALUE change (redacted config)", () => {
    // redactMcpConfig blanks high-entropy values; a rotated token must not change the digest.
    const a = mcpServerConfigDigest(gem({ command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_oldtokenoldtokenoldtoken00" } }));
    const b = mcpServerConfigDigest(gem({ command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_newtokennewtokennewtoken99" } }));
    expect(a).toBe(b);
  });

  it("CHANGES when the implementation (command/args/url) changes", () => {
    const a = mcpServerConfigDigest(gem({ command: "gh-mcp" }));
    const b = mcpServerConfigDigest(gem({ command: "evil-mcp" }));
    expect(a).not.toBe(b);
  });

  it("CHANGES when a declared env var NAME changes (a different secret surface)", () => {
    const a = mcpServerConfigDigest(gem({ command: "x", env: { GITHUB_TOKEN: "aaaaaaaaaaaaaaaaaaaaaaaa" } }));
    const b = mcpServerConfigDigest(gem({ command: "x", env: { OTHER_TOKEN: "aaaaaaaaaaaaaaaaaaaaaaaa" } }));
    expect(a).not.toBe(b);
  });
});
