// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { readAgentPlugin, writeGemArchive, readGemArchive } from "@agentgem/archive";
import { InvalidInputError } from "@agentgem/model";

const fixture = (): Record<string, string> => ({
  "plugin.json": JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "reports-plugin", version: "1.2.0", license: "MIT",
  }),
  "skills/summarize/SKILL.md": "# Summarize\nDo it.",
  "skills/summarize/scripts/analyze.sh": "#!/bin/sh\n",
  "skills/summarize/references/checklist.md": "- check\n",
  "skills/not-a-skill/README.md": "no SKILL.md here",
  "mcp.json": JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      validator: { type: "stdio", command: "./bin/validate", args: ["--fast"], cwd: "${PLUGIN_ROOT}" },
      deploy: { type: "streamable-http", url: "https://deploy.example.com/mcp", headers: { "X-T": "p" } },
      legacy: { type: "websocket", url: "wss://nope" },
    },
  }),
  "com.example.client/hooks/hooks.json": "{}",
  "LICENSE": "MIT",
});

describe("readAgentPlugin", () => {
  it("imports skills (with sibling files) and MCP servers, ignoring extensions", () => {
    const { gem, skipped, notes } = readAgentPlugin(fixture());
    expect(gem.name).toBe("reports-plugin");
    expect(gem.createdFrom).toBe("Imported from Agent Plugin 'reports-plugin' v1.2.0");
    const skill = gem.artifacts.find((a) => a.type === "skill");
    expect(skill).toMatchObject({ name: "summarize", source: "agent-plugin", content: "# Summarize\nDo it." });
    expect((skill as { files?: unknown[] }).files).toEqual([
      { path: "references/checklist.md", content: "- check\n" },
      { path: "scripts/analyze.sh", content: "#!/bin/sh\n" },
    ]);
    const servers = gem.artifacts.filter((a) => a.type === "mcp_server");
    expect(servers).toEqual([
      { type: "mcp_server", name: "validator", transport: "stdio", config: { command: "./bin/validate", args: ["--fast"], cwd: "${PLUGIN_ROOT}" } },
      { type: "mcp_server", name: "deploy", transport: "http", config: { url: "https://deploy.example.com/mcp", headers: { "X-T": "p" } } },
    ]);
    expect(skipped.some((s) => s.artifact === "legacy" && s.type === "mcp_server")).toBe(true);
    expect(notes).toEqual([]); // license is a KNOWN manifest field
    expect(gem.checks).toEqual([]);
    expect(gem.requiredSecrets).toEqual([]);
  });
  it("reports unknown manifest fields as notes, non-fatally", () => {
    const f = fixture();
    f["plugin.json"] = JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "x", futureField: 1 });
    const { gem, notes } = readAgentPlugin(f);
    expect(gem.name).toBe("x");
    expect(notes.some((n) => n.includes("futureField"))).toBe(true);
  });
  it("rejects a missing or invalid manifest", () => {
    expect(() => readAgentPlugin({})).toThrow(InvalidInputError);
    const f = fixture();
    f["plugin.json"] = JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "Bad--Name" });
    expect(() => readAgentPlugin(f)).toThrow(InvalidInputError);
  });
  it("skips a version-mismatched mcp.json wholesale but keeps skills", () => {
    const f = fixture();
    f["mcp.json"] = JSON.stringify({ $schema: "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json", mcpServers: {} });
    const { gem, notes } = readAgentPlugin(f);
    expect(gem.artifacts.some((a) => a.type === "skill")).toBe(true);
    expect(gem.artifacts.some((a) => a.type === "mcp_server")).toBe(false);
    expect(notes.some((n) => n.includes("mcp.json"))).toBe(true);
  });
  it("imported gems survive our archive round-trip", () => {
    const { gem } = readAgentPlugin(fixture());
    expect(readGemArchive(writeGemArchive(gem).files)).toEqual(gem);
  });
  it("imports an empty-but-valid plugin as a zero-artifact gem", () => {
    const f = { "plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "empty" }) };
    const { gem, skipped, notes } = readAgentPlugin(f);
    expect(gem.artifacts).toEqual([]);
    expect(skipped).toEqual([]);
    expect(notes).toEqual([]);
  });
  it("skips traversal-shaped sibling paths from a hostile tree", () => {
    const f = fixture();
    f["skills/summarize/../../evil.sh"] = "x";
    const { gem, skipped } = readAgentPlugin(f);
    const skill = gem.artifacts.find((a) => a.type === "skill");
    expect((skill as { files?: { path: string }[] }).files!.every((x) => !x.path.includes(".."))).toBe(true);
    expect(skipped.some((s) => s.reason.includes("unsafe"))).toBe(true);
  });
  it("skips a null mcp.json server entry, leaving other artifacts intact", () => {
    const f = fixture();
    f["mcp.json"] = JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        validator: { type: "stdio", command: "./bin/validate" },
        broken: null,
      },
    });
    const { gem, skipped } = readAgentPlugin(f);
    expect(skipped.some((s) => s.artifact === "broken" && s.type === "mcp_server" && s.reason.length > 0)).toBe(true);
    expect(gem.artifacts.some((a) => a.type === "mcp_server" && a.name === "validator")).toBe(true);
    expect(gem.artifacts.some((a) => a.type === "skill")).toBe(true);
  });
  it("rejects a plugin.json whose parsed body isn't a JSON object", () => {
    const f = fixture();
    f["plugin.json"] = "null";
    expect(() => readAgentPlugin(f)).toThrow(InvalidInputError);
    f["plugin.json"] = "[]";
    expect(() => readAgentPlugin(f)).toThrow(InvalidInputError);
  });
  it("skips a sibling path containing a backslash", () => {
    const f = fixture();
    f["skills/summarize/scripts\\evil.sh"] = "x";
    const { gem, skipped } = readAgentPlugin(f);
    const skill = gem.artifacts.find((a) => a.type === "skill");
    expect((skill as { files?: { path: string }[] }).files!.every((x) => !x.path.includes("\\"))).toBe(true);
    expect(skipped.some((s) => s.reason.includes("unsafe"))).toBe(true);
  });
});
