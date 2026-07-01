// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGeminiArtifacts } from "@agentgem/insight";
import { materialize } from "@agentgem/model";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";

describe("Gemini round-trip: import -> Gem -> archive -> materialize back", () => {
  it("reproduces GEMINI.md, command, and MCP (package ref as npx); binding is dropped by the archive", async () => {
    const base = mkdtempSync(join(tmpdir(), "gemrt-"));
    writeFileSync(join(base, "GEMINI.md"), "Small, verifiable steps.");
    writeFileSync(join(base, "settings.json"), JSON.stringify({ model: { name: "gemini-2.5-pro" }, mcpServers: {
      context7: { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] },
    } }));
    mkdirSync(join(base, "commands", "git"), { recursive: true });
    writeFileSync(join(base, "commands", "git", "commit.toml"), 'prompt = "Commit for {{args}}"');

    const { artifacts, binding } = await readGeminiArtifacts({ contextFile: join(base, "GEMINI.md"), settingsFile: join(base, "settings.json"), commandsDir: join(base, "commands") });
    const gem: Gem = { name: "imported", createdFrom: "gemini", artifacts, checks: [], requiredSecrets: [], bindings: [binding] };

    const back = readGemArchive(writeGemArchive(gem).files);
    expect(back.artifacts).toEqual(gem.artifacts);          // references survive the signed archive
    expect(back.bindings).toBeUndefined();                  // binding is an in-memory overlay only

    const { files } = materialize(back, "gemini");
    expect(files["GEMINI.md"]).toBe("Small, verifiable steps.");
    expect(files[".gemini/commands/git/commit.toml"]).toContain("Commit for {{args}}");
    expect(JSON.parse(files[".gemini/settings.json"]).mcpServers.context7).toMatchObject({ command: "npx", args: ["@modelcontextprotocol/server-context7"] });
  });
});
