// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContinueArtifacts } from "@agentgem/insight";

const yaml = `
name: my-assistant
version: 0.0.1
models:
  - name: Sonnet
    provider: anthropic
    model: claude-sonnet-5
    roles: [chat]
mcpServers:
  - name: context7
    command: npx
    args: ["-y", "@modelcontextprotocol/server-context7"]
  - name: local
    command: node
    args: ["./s.js"]
    env: { TOKEN: "secret" }
rules:
  - "Always write tests first."
  - name: style
    rule: "Prefer small diffs."
prompts:
  - name: commit
    prompt: "Write a commit for {{{ input }}}"
    description: commit helper
`;

describe("Continue artifact import", () => {
  it("imports mcpServers(array)→ref/redacted, rules→instructions, prompts→skills", async () => {
    const base = mkdtempSync(join(tmpdir(), "cont-"));
    writeFileSync(join(base, "config.yaml"), yaml);
    const { artifacts, binding } = await readContinueArtifacts({ configFile: join(base, "config.yaml") });

    expect(artifacts.find((a) => a.type === "reference")).toMatchObject({ refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } });
    const local = artifacts.find((a) => a.type === "mcp_server");
    expect(local).toMatchObject({ name: "local" });
    expect(JSON.stringify(local)).not.toContain("secret");   // env redacted
    const instr = artifacts.filter((a) => a.type === "instructions").map((a) => a.content);
    expect(instr).toContain("Always write tests first.");
    expect(instr).toContain("Prefer small diffs.");
    const skill = artifacts.find((a) => a.type === "skill");
    expect(skill).toMatchObject({ name: "commit", content: "Write a commit for {{{ input }}}" });
    expect(binding).toMatchObject({ agent: "continue", origin: "imported", model: "claude-sonnet-5" });
  });
});
