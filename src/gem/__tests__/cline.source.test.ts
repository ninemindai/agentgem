// src/gem/__tests__/cline.source.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SOURCES } from "@agentgem/insight";

describe("cline SourceSpec", () => {
  it("is registered with json storage and both faces", () => {
    const cline = BUILTIN_SOURCES.find((s) => s.id === "cline");
    expect(cline?.traits.storage).toBe("json");
    expect(typeof cline?.scanSessions).toBe("function");
    expect(typeof cline?.readArtifacts).toBe("function");
  });
  it("returns [] roots when no globalStorage exists (never throws)", async () => {
    const cline = BUILTIN_SOURCES.find((s) => s.id === "cline")!;
    await expect(cline.scanSessions!(cline.roots({ baseDir: "/no/such" }))).resolves.toEqual([]);
  });
  it("readArtifacts derives .clinerules/cline_mcp_settings.json from baseDir and reads real content", async () => {
    const cline = BUILTIN_SOURCES.find((s) => s.id === "cline")!;
    const base = mkdtempSync(join(tmpdir(), "cline-source-"));
    writeFileSync(join(base, ".clinerules"), "Always write tests first.");
    writeFileSync(join(base, "cline_mcp_settings.json"), JSON.stringify({ mcpServers: {
      context7: { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] },
    } }));
    const { artifacts, binding } = await cline.readArtifacts!({ baseDir: base });
    expect(artifacts.find((a) => a.type === "instructions")).toMatchObject({ content: "Always write tests first." });
    expect(artifacts.find((a) => a.type === "reference")).toMatchObject({ ref: { id: "npx:@modelcontextprotocol/server-context7" } });
    expect(binding).toMatchObject({ agent: "cline", origin: "imported" });
  });
  it("readArtifacts with no baseDir returns empty results (no reliable global config-home to fall back to)", async () => {
    const cline = BUILTIN_SOURCES.find((s) => s.id === "cline")!;
    await expect(cline.readArtifacts!({})).resolves.toEqual({ artifacts: [], binding: { agent: "cline", origin: "imported" } });
  });
});
