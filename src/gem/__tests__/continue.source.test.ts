// src/gem/__tests__/continue.source.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SOURCES } from "@agentgem/insight";

describe("continue SourceSpec", () => {
  it("is registered with json storage and both faces", () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "continue");
    expect(c?.traits.storage).toBe("json");
    expect(typeof c?.scanSessions).toBe("function");
    expect(typeof c?.readArtifacts).toBe("function");
  });
  it("absent ~/.continue yields [] sessions, never throws", async () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "continue")!;
    await expect(c.scanSessions!(c.roots({ baseDir: "/no/such" }))).resolves.toEqual([]);
  });
  it("readArtifacts derives config.yaml from baseDir and reads real content", async () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "continue")!;
    const base = mkdtempSync(join(tmpdir(), "cont-source-"));
    writeFileSync(join(base, "config.yaml"), [
      "models:",
      "  - name: Sonnet",
      "    model: claude-sonnet-5",
      "    roles: [chat]",
      "rules:",
      '  - "Always write tests first."',
    ].join("\n"));
    const { artifacts, binding } = await c.readArtifacts!({ baseDir: base });
    expect(artifacts.find((a) => a.type === "instructions")).toMatchObject({ content: "Always write tests first." });
    expect(binding).toMatchObject({ agent: "continue", model: "claude-sonnet-5" });
  });
  it("a bare scalar `rules:` string does not explode into per-character artifacts", async () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "continue")!;
    const base = mkdtempSync(join(tmpdir(), "cont-source-scalar-"));
    writeFileSync(join(base, "config.yaml"), 'rules: "Always write tests first."\n');
    const { artifacts } = await c.readArtifacts!({ baseDir: base });
    const instructions = artifacts.filter((a) => a.type === "instructions");
    expect(instructions.some((a) => "content" in a && typeof a.content === "string" && a.content.length === 1)).toBe(false);
    expect(instructions).toEqual([]);
  });
  it("falls back to legacy config.json when config.yaml is absent", async () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "continue")!;
    const base = mkdtempSync(join(tmpdir(), "cont-source-json-"));
    writeFileSync(join(base, "config.json"), JSON.stringify({ rules: ["Always write tests first."] }));
    const { artifacts } = await c.readArtifacts!({ baseDir: base });
    expect(artifacts.find((a) => a.type === "instructions")).toMatchObject({ content: "Always write tests first." });
  });
});
