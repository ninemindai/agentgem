import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@agentgem/model";
import type { Gem } from "@agentgem/model";
import { readGeminiArtifacts } from "@agentgem/insight";

const gem: Gem = { name: "g", createdFrom: "t", checks: [], requiredSecrets: [], artifacts: [
  { type: "instructions", name: "ctx", content: "Be concise." },
  { type: "skill", name: "git:commit", source: "gemini-command", content: "Write a commit for {{args}}" },
  { type: "mcp_server", name: "local", transport: "stdio", config: { command: "node", args: ["s.js"] } },
  { type: "reference", name: "context7", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } },
] };

describe("gemini target", () => {
  it("writes GEMINI.md, a namespaced command TOML, and settings.json mcpServers (ref as npx)", () => {
    const { files } = materialize(gem, "gemini");
    expect(files["GEMINI.md"]).toBe("Be concise.");
    expect(files[".gemini/commands/git/commit.toml"]).toContain("Write a commit for {{args}}");
    const settings = JSON.parse(files[".gemini/settings.json"]);
    expect(settings.mcpServers.local).toMatchObject({ command: "node", args: ["s.js"] });
    expect(settings.mcpServers.context7).toMatchObject({ command: "npx", args: ["@modelcontextprotocol/server-context7"] });
  });

  it("round-trips skill content that would corrupt the TOML literal-string emit (trailing apostrophe, embedded newline+quote)", async () => {
    const trailingApostrophe = "Wrap it up y'all'";               // ends in a single '
    const trailingDouble = "Nested quotes: 'a''b''";               // ends in two ''
    const newlineAndQuote = 'Line one\nSay "hi" to the user\nLine three';
    // Ends in a single apostrophe (forces the JSON.stringify basic-string fallback) AND contains a
    // literal backslash-then-n (not a newline) — the sequential-replace unescape used to turn this
    // into a real newline (C:\<LF>otes'), silently corrupting the path.
    const backslashN = "C:\\notes'";
    const roundTripGem: Gem = { name: "g2", createdFrom: "t", checks: [], requiredSecrets: [], artifacts: [
      { type: "skill", name: "trail-one", source: "gemini-command", content: trailingApostrophe },
      { type: "skill", name: "trail-two", source: "gemini-command", content: trailingDouble },
      { type: "skill", name: "newline-quote", source: "gemini-command", content: newlineAndQuote },
      { type: "skill", name: "backslash-n", source: "gemini-command", content: backslashN },
    ] };

    const { files } = materialize(roundTripGem, "gemini");
    const base = mkdtempSync(join(tmpdir(), "gemini-roundtrip-"));
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith(".gemini/commands/")) continue;
      const abs = join(base, path.slice(".gemini/commands/".length));
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }

    const { artifacts } = await readGeminiArtifacts({ commandsDir: base });
    const byName = (n: string) => artifacts.find((a) => a.type === "skill" && a.name === n) as { content: string } | undefined;
    expect(byName("trail-one")?.content).toBe(trailingApostrophe);
    expect(byName("trail-two")?.content).toBe(trailingDouble);
    expect(byName("newline-quote")?.content).toBe(newlineAndQuote);
    expect(byName("backslash-n")?.content).toBe(backslashN);
  });
});
