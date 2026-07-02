// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContinueArtifacts } from "@agentgem/insight";
import { materialize } from "@agentgem/model";
import { parse as parseYaml } from "yaml";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";

const yaml = `
name: src
version: 0.0.1
mcpServers:
  - name: context7
    command: npx
    args: ["-y", "@modelcontextprotocol/server-context7"]
rules:
  - name: style
    rule: "Prefer small diffs."
prompts:
  - name: commit
    prompt: "Commit for {{{ input }}}"
`;

describe("Continue round-trip: import -> Gem -> archive -> materialize back", () => {
  it("reproduces rules, prompts, and MCP (package ref as npx); binding dropped by the archive", async () => {
    const base = mkdtempSync(join(tmpdir(), "cont-rt-"));
    writeFileSync(join(base, "config.yaml"), yaml);
    const { artifacts, binding } = await readContinueArtifacts({ configFile: join(base, "config.yaml") });
    const gem: Gem = { name: "imported", createdFrom: "continue", artifacts, checks: [], requiredSecrets: [], bindings: [binding] };

    const back = readGemArchive(writeGemArchive(gem).files);
    expect(back.artifacts).toEqual(gem.artifacts);   // rules/prompts/refs survive the signed archive
    expect(back.bindings).toBeUndefined();

    const cfg = parseYaml(materialize(back, "continue").files["config.yaml"]);
    expect(cfg.rules).toContainEqual({ name: "style", rule: "Prefer small diffs." });
    expect(cfg.prompts).toContainEqual({ name: "commit", prompt: "Commit for {{{ input }}}" });
    expect(cfg.mcpServers.find((m: { name: string }) => m.name === "context7")).toMatchObject({ command: "npx", args: ["@modelcontextprotocol/server-context7"] });
  });
});
