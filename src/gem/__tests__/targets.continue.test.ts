// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { materialize } from "@agentgem/model";
import { parse as parseYaml } from "yaml";
import type { Gem } from "@agentgem/model";

const gem: Gem = { name: "my-gem", createdFrom: "t", checks: [], requiredSecrets: [], artifacts: [
  { type: "instructions", name: "style", content: "Prefer small diffs." },
  { type: "skill", name: "commit", source: "continue-prompt", content: "Write a commit for {{{ input }}}" },
  { type: "mcp_server", name: "local", transport: "stdio", config: { command: "node", args: ["s.js"] } },
  { type: "reference", name: "context7", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } },
] };

describe("continue target", () => {
  it("emits one config.yaml with rules, prompts, and mcpServers (ref as npx); nothing spuriously skipped", () => {
    const { files, skipped } = materialize(gem, "continue");
    expect(skipped).toEqual([]);   // no-op per-type renderers suppress the spurious "unsupported" skips
    const cfg = parseYaml(files["config.yaml"]);
    expect(cfg.name).toBe("my-gem");
    expect(cfg.version).toBeTruthy();
    expect(cfg.rules).toContainEqual({ name: "style", rule: "Prefer small diffs." });
    expect(cfg.prompts).toContainEqual({ name: "commit", prompt: "Write a commit for {{{ input }}}" });
    const byName = (n: string) => cfg.mcpServers.find((m: { name: string }) => m.name === n);
    expect(byName("local")).toMatchObject({ name: "local", command: "node", args: ["s.js"] });
    expect(byName("context7")).toMatchObject({ name: "context7", command: "npx", args: ["@modelcontextprotocol/server-context7"] });
  });
});
