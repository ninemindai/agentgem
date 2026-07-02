// src/gem/__tests__/gemini.source.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SOURCES } from "@agentgem/insight";

describe("gemini SourceSpec", () => {
  it("is registered with jsonl storage and a scan face", () => {
    const g = BUILTIN_SOURCES.find((s) => s.id === "gemini");
    expect(g?.traits.storage).toBe("jsonl");
    expect(typeof g?.scanSessions).toBe("function");
    expect(typeof g?.readArtifacts).toBe("function");
  });
  it("absent ~/.gemini yields [] sessions, never throws", async () => {
    const g = BUILTIN_SOURCES.find((s) => s.id === "gemini")!;
    await expect(g.scanSessions!(g.roots({ baseDir: "/no/such" }))).resolves.toEqual([]);
  });
  it("readArtifacts derives GEMINI.md/settings.json/commands from baseDir and reads real content", async () => {
    const g = BUILTIN_SOURCES.find((s) => s.id === "gemini")!;
    const base = mkdtempSync(join(tmpdir(), "gem-source-"));
    writeFileSync(join(base, "GEMINI.md"), "Prefer concise diffs.");
    writeFileSync(join(base, "settings.json"), JSON.stringify({ model: { name: "gemini-2.5-pro" }, mcpServers: {
      context7: { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] },
    } }));
    const { artifacts, binding } = await g.readArtifacts!({ baseDir: base });
    expect(artifacts.find((a) => a.type === "instructions")).toMatchObject({ content: "Prefer concise diffs." });
    expect(artifacts.find((a) => a.type === "reference")).toMatchObject({ ref: { id: "npx:@modelcontextprotocol/server-context7" } });
    expect(binding).toMatchObject({ agent: "gemini", model: "gemini-2.5-pro" });
  });
});
