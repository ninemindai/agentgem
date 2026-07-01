// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGeminiArtifacts } from "@agentgem/insight";

describe("Gemini artifact import", () => {
  it("imports GEMINI.md, mcpServers (public npx → ref, private → redacted), commands → skills", async () => {
    const base = mkdtempSync(join(tmpdir(), "gem-"));
    writeFileSync(join(base, "GEMINI.md"), "Prefer concise diffs.");
    writeFileSync(join(base, "settings.json"), JSON.stringify({ model: { name: "gemini-2.5-pro" }, mcpServers: {
      context7: { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] },
      local: { command: "node", args: ["./s.js"], env: { TOKEN: "secret" } },
    } }));
    const cmds = join(base, "commands", "git"); mkdirSync(cmds, { recursive: true });
    writeFileSync(join(base, "commands", "git", "commit.toml"), 'prompt = "Write a commit for {{args}}"\ndescription = "commit helper"');

    const { artifacts, binding } = await readGeminiArtifacts({ contextFile: join(base, "GEMINI.md"), settingsFile: join(base, "settings.json"), commandsDir: join(base, "commands") });
    expect(artifacts.find((a) => a.type === "instructions")).toMatchObject({ content: "Prefer concise diffs." });
    expect(artifacts.find((a) => a.type === "reference")).toMatchObject({ refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } });
    const local = artifacts.find((a) => a.type === "mcp_server");
    expect(local).toMatchObject({ name: "local" });
    expect(JSON.stringify(local)).not.toContain("secret");                 // env redacted
    const skill = artifacts.find((a) => a.type === "skill");
    expect(skill).toMatchObject({ name: "git:commit", content: "Write a commit for {{args}}" });  // namespaced
    expect(binding).toMatchObject({ agent: "gemini", origin: "imported", model: "gemini-2.5-pro" });
  });
});
