// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClineArtifacts } from "@agentgem/insight";
import { materialize } from "@agentgem/model";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";

describe("Cline round-trip: import -> Gem -> archive -> materialize back", () => {
  it("reproduces rules + MCP, survives the archive, keeps the package ref as npx", async () => {
    const base = mkdtempSync(join(tmpdir(), "rt-"));
    writeFileSync(join(base, ".clinerules"), "Prefer small diffs.");
    const settings = join(base, "settings"); mkdirSync(settings);
    writeFileSync(join(settings, "cline_mcp_settings.json"), JSON.stringify({ mcpServers: {
      context7: { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] },
    } }));

    const { artifacts, binding } = await readClineArtifacts({ rulesFile: join(base, ".clinerules"), mcpSettingsFile: join(settings, "cline_mcp_settings.json") });
    const gem: Gem = { name: "imported", createdFrom: "cline", artifacts, checks: [], requiredSecrets: [], bindings: [binding] };

    // survives the signed archive
    const back = readGemArchive(writeGemArchive(gem).files);
    expect(back.artifacts).toEqual(gem.artifacts);

    // materializes back into Cline's native layout
    const { files } = materialize(back, "cline");
    expect(files[".clinerules"]).toBe("Prefer small diffs.");
    expect(JSON.parse(files["cline_mcp_settings.json"]).mcpServers.context7).toMatchObject({ command: "npx", args: ["@modelcontextprotocol/server-context7"] });
    // binding is an in-memory overlay: present on the gem, absent from the archive
    expect(back.bindings).toBeUndefined();
  });
});
