// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCursorArtifacts } from "@agentgem/insight";
import { materialize } from "@agentgem/model";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";

describe("Cursor round-trip: import -> Gem -> archive -> materialize back", () => {
  it("reproduces the rule body + MCP (package ref as npx); binding dropped by the archive", async () => {
    const base = mkdtempSync(join(tmpdir(), "cursor-rt-"));
    const rulesDir = join(base, ".cursor", "rules"); mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "style.mdc"), "---\nalwaysApply: true\n---\nPrefer small diffs.");
    writeFileSync(join(base, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { context7: { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] } } }));

    const { artifacts, binding } = await readCursorArtifacts({ rulesDir, mcpFile: join(base, ".cursor", "mcp.json") });
    const gem: Gem = { name: "imported", createdFrom: "cursor", artifacts, checks: [], requiredSecrets: [], bindings: [binding] };

    const back = readGemArchive(writeGemArchive(gem).files);
    expect(back.artifacts).toEqual(gem.artifacts);   // rule body + ref survive the signed archive
    expect(back.bindings).toBeUndefined();

    const { files } = materialize(back, "cursor");
    expect(files[".cursor/rules/style.mdc"]).toContain("Prefer small diffs.");
    expect(JSON.parse(files[".cursor/mcp.json"]).mcpServers.context7).toMatchObject({ command: "npx", args: ["@modelcontextprotocol/server-context7"] });
  });
});
