// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { writeGemArchive, readGemArchive, computeLock } from "@agentgem/archive";
import type { Gem, McpServerArtifact } from "@agentgem/model";

const baseGem = (): Gem => ({
  name: "My Test Gem!",
  createdFrom: "unit test",
  artifacts: [{ type: "skill", name: "summarize", source: "standalone", content: "# Summarize\nDo the thing." }],
  checks: [],
  requiredSecrets: [],
});

describe("archive v2: plugin.json", () => {
  it("emits a spec-shaped plugin.json with slugged name", () => {
    const { files } = writeGemArchive(baseGem(), { version: "1.2.0" });
    const p = JSON.parse(files["plugin.json"]);
    expect(p).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "my-test-gem",
      version: "1.2.0",
    });
  });
  it("stamps formatVersion 2 in gem.json and gem.lock, and lock covers plugin.json", () => {
    const { files } = writeGemArchive(baseGem());
    expect(JSON.parse(files["gem.json"]).formatVersion).toBe(2);
    const lock = JSON.parse(files["gem.lock"]);
    expect(lock.formatVersion).toBe(2);
    expect(lock.files["plugin.json"]).toMatch(/^sha256:/);
  });
  it("round-trips: plugin.json is derived output, never read back", () => {
    const gem = baseGem();
    expect(readGemArchive(writeGemArchive(gem).files)).toEqual(gem);
  });
  it("still reads a formatVersion 1 archive (no plugin.json)", () => {
    const files: Record<string, string> = {
      "gem.json": JSON.stringify({
        formatVersion: 1, name: "old", version: "0.1.0", createdFrom: "unit test",
        artifacts: [{ type: "skill", name: "s", path: "skills/s/SKILL.md", source: "standalone" }],
        requiredSecrets: [], checks: [],
      }),
      "skills/s/SKILL.md": "# S",
    };
    files["gem.lock"] = JSON.stringify(computeLock(files));
    const gem = readGemArchive(files);
    expect(gem.name).toBe("old");
    expect(gem.artifacts).toEqual([{ type: "skill", name: "s", source: "standalone", content: "# S" }]);
  });
  it("rejects an unknown formatVersion", () => {
    const files: Record<string, string> = {
      "gem.json": JSON.stringify({ formatVersion: 3, name: "future", version: "0.1.0", createdFrom: "x", artifacts: [], requiredSecrets: [], checks: [] }),
    };
    files["gem.lock"] = JSON.stringify(computeLock(files));
    expect(() => readGemArchive(files)).toThrow(/formatVersion/);
  });
});

describe("archive v2: skill sibling files", () => {
  const gemWithFiles = (): Gem => ({
    name: "g", createdFrom: "unit test", checks: [], requiredSecrets: [],
    artifacts: [{
      type: "skill", name: "summarize", source: "standalone", content: "# S",
      files: [
        { path: "scripts/analyze.sh", content: "#!/bin/sh\necho hi\n" },
        { path: "references/checklist.md", content: "- [ ] check\n" },
      ],
    }],
  });
  it("places sibling files under the skill dir and round-trips them", () => {
    const { files } = writeGemArchive(gemWithFiles());
    expect(files["skills/summarize/scripts/analyze.sh"]).toBe("#!/bin/sh\necho hi\n");
    expect(files["skills/summarize/references/checklist.md"]).toBe("- [ ] check\n");
    expect(readGemArchive(files)).toEqual(gemWithFiles());
  });
  it("round-trips filesTruncated", () => {
    const gem = gemWithFiles();
    (gem.artifacts[0] as { filesTruncated?: boolean }).filesTruncated = true;
    expect(readGemArchive(writeGemArchive(gem).files)).toEqual(gem);
  });
  it("skips unsafe sibling paths instead of writing them", () => {
    const gem = gemWithFiles();
    (gem.artifacts[0] as { files: { path: string; content: string }[] }).files = [{ path: "../evil.sh", content: "x" }];
    const { files, skipped } = writeGemArchive(gem);
    expect(Object.keys(files).some((p) => p.includes("evil"))).toBe(false);
    expect(skipped.some((s) => s.reason.includes("unsafe"))).toBe(true);
  });
  it("keeps a no-files skill byte-identical to a plain write (digest safety)", () => {
    const a = writeGemArchive(baseGem()).files;
    const b = writeGemArchive(baseGem()).files;
    expect(a).toEqual(b);
    expect(JSON.parse(a["gem.json"]).artifacts[0].files).toBeUndefined();
  });
  it("skips backslash-separated sibling paths instead of writing them", () => {
    const gem = gemWithFiles();
    (gem.artifacts[0] as { files: { path: string; content: string }[] }).files = [
      { path: "..\\..\\evil.sh", content: "x" },
      { path: "scripts\\x.sh", content: "y" },
    ];
    const { files, skipped } = writeGemArchive(gem);
    expect(Object.keys(files).some((p) => p.includes("evil"))).toBe(false);
    expect(skipped.filter((s) => s.reason.includes("unsafe")).length).toBe(2);
  });
});

describe("archive v2: mcp.json folding", () => {
  const mk = (over: Partial<McpServerArtifact>): Gem => ({
    name: "g", createdFrom: "unit test", checks: [], requiredSecrets: [],
    artifacts: [{ type: "mcp_server", name: "db server", transport: "stdio", config: { command: "npx", args: ["-y", "db-mcp"] }, ...over } as McpServerArtifact],
  });
  it("writes a portable stdio server into spec-shaped mcp.json only", () => {
    const { files } = writeGemArchive(mk({}));
    const doc = JSON.parse(files["mcp.json"]);
    expect(doc.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    expect(doc.mcpServers["db_server"]).toEqual({ type: "stdio", command: "npx", args: ["-y", "db-mcp"] });
    expect(Object.keys(files).some((p) => p.startsWith("mcp/"))).toBe(false);
  });
  it("maps http to streamable-http and back", () => {
    const gem = mk({ transport: "http", config: { url: "https://x.example/mcp", headers: { "X-T": "1" } } });
    const { files } = writeGemArchive(gem);
    expect(JSON.parse(files["mcp.json"]).mcpServers["db_server"].type).toBe("streamable-http");
    expect(readGemArchive(files)).toEqual(gem);
  });
  it("carries non-spec config keys, source, and secretRefs via the manifest entry", () => {
    const gem = mk({ source: "claude", secretRefs: [{ name: "DB_TOKEN", location: "env.DB_TOKEN" }], config: { command: "npx", timeoutMs: 5000, env: { PLUGIN_ROOT: "reserved" } } } as Partial<McpServerArtifact>);
    const { files } = writeGemArchive(gem);
    const entry = JSON.parse(files["gem.json"]).artifacts[0];
    expect(entry.path).toBe("mcp.json");
    expect(entry.extra).toEqual({ timeoutMs: 5000, env: { PLUGIN_ROOT: "reserved" } });
    const server = JSON.parse(files["mcp.json"]).mcpServers["db_server"];
    expect(server.env).toBeUndefined(); // reserved name kept OUT of spec surface
    expect(readGemArchive(files)).toEqual(gem);
  });
  it("falls back to mcp/<n>.json for a non-portable server and writes no mcp.json", () => {
    const gem = mk({ config: { note: "no command" } });
    const { files } = writeGemArchive(gem);
    expect(files["mcp.json"]).toBeUndefined();
    expect(files["mcp/db_server.json"]).toBeDefined();
    expect(readGemArchive(files)).toEqual(gem);
  });
  it("rejects plain-http non-loopback urls as non-portable", () => {
    const { files } = writeGemArchive(mk({ transport: "http", config: { url: "http://x.example/mcp" } }));
    expect(files["mcp.json"]).toBeUndefined();
  });
  it("skips the second server when two names slug to the same mcp.json key", () => {
    const gem: Gem = { ...mk({}), artifacts: [
      { type: "mcp_server", name: "db server", transport: "stdio", config: { command: "a" } },
      { type: "mcp_server", name: "db_server", transport: "stdio", config: { command: "b" } },
    ] };
    const { files, skipped } = writeGemArchive(gem);
    expect(JSON.parse(files["mcp.json"]).mcpServers["db_server"].command).toBe("a");
    expect(skipped.some((s) => s.type === "mcp_server" && s.reason.includes("collision"))).toBe(true);
  });
  it("keeps a non-conforming cwd out of mcp.json and round-trips it via extra", () => {
    const gem = mk({ config: { command: "npx", cwd: "/abs/checkout" } });
    const { files } = writeGemArchive(gem);
    expect(JSON.parse(files["mcp.json"]).mcpServers["db_server"].cwd).toBeUndefined();
    expect(JSON.parse(files["gem.json"]).artifacts[0].extra).toEqual({ cwd: "/abs/checkout" });
    expect(readGemArchive(files)).toEqual(gem);
  });
  it("round-trips an sse server", () => {
    const gem = mk({ transport: "sse", config: { url: "https://x.example/sse" } });
    const { files } = writeGemArchive(gem);
    expect(JSON.parse(files["mcp.json"]).mcpServers["db_server"].type).toBe("sse");
    expect(readGemArchive(files)).toEqual(gem);
  });
  it("REGRESSION: still reads a v1 archive whose server lives at mcp/<n>.json", () => {
    const files: Record<string, string> = {
      "gem.json": JSON.stringify({
        formatVersion: 1, name: "old", version: "0.1.0", createdFrom: "unit test",
        artifacts: [{ type: "mcp_server", name: "db", path: "mcp/db.json" }],
        requiredSecrets: [], checks: [],
      }),
      "mcp/db.json": JSON.stringify({ transport: "stdio", config: { command: "npx" } }),
    };
    files["gem.lock"] = JSON.stringify(computeLock(files));
    expect(readGemArchive(files).artifacts).toEqual([
      { type: "mcp_server", name: "db", transport: "stdio", config: { command: "npx" } },
    ]);
  });
});
