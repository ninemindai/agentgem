// src/gem/__tests__/cursor.source.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SOURCES } from "@agentgem/insight";

describe("cursor SourceSpec", () => {
  it("is registered with sqlite storage and both faces", () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "cursor");
    expect(c?.traits.storage).toBe("sqlite");
    expect(typeof c?.scanSessions).toBe("function");
    expect(typeof c?.readArtifacts).toBe("function");
  });
  it("absent Cursor DB yields [] sessions, never throws", async () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "cursor")!;
    await expect(c.scanSessions!(c.roots({ baseDir: "/no/such" }))).resolves.toEqual([]);
  });
  it("readArtifacts derives mcp.json (global only, not per-repo rules) from baseDir and reads real content", async () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "cursor")!;
    const base = mkdtempSync(join(tmpdir(), "cursor-source-"));
    writeFileSync(join(base, "mcp.json"), JSON.stringify({ mcpServers: {
      context7: { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] },
    } }));
    const { artifacts, binding } = await c.readArtifacts!({ baseDir: base });
    expect(artifacts.find((a) => a.type === "reference")).toMatchObject({ ref: { id: "npx:@modelcontextprotocol/server-context7" } });
    expect(artifacts.find((a) => a.type === "instructions")).toBeUndefined(); // rules/AGENTS.md are per-repo, out of scope
    expect(binding).toMatchObject({ agent: "cursor", origin: "imported" });
  });
});
