// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClineArtifacts } from "@agentgem/insight";

describe("Cline artifact import", () => {
  it("imports .clinerules as instructions and MCP servers, with a public npx server as a package reference", async () => {
    const base = mkdtempSync(join(tmpdir(), "cline-"));
    writeFileSync(join(base, ".clinerules"), "Always write tests first.");
    const settings = join(base, "settings"); mkdirSync(settings);
    writeFileSync(join(settings, "cline_mcp_settings.json"), JSON.stringify({ mcpServers: {
      context7: { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] },
      local: { command: "node", args: ["./my-server.js"], env: { TOKEN: "secret" } },
    } }));
    const { artifacts, binding } = await readClineArtifacts({ rulesFile: join(base, ".clinerules"), mcpSettingsFile: join(settings, "cline_mcp_settings.json") });
    const instr = artifacts.find((a) => a.type === "instructions");
    expect(instr).toMatchObject({ type: "instructions", content: "Always write tests first." });
    const ref = artifacts.find((a) => a.type === "reference");
    expect(ref).toMatchObject({ type: "reference", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } });
    const local = artifacts.find((a) => a.type === "mcp_server");
    expect(local).toMatchObject({ type: "mcp_server", name: "local" });
    expect(JSON.stringify(local)).not.toContain("secret"); // env redacted
    expect(binding).toMatchObject({ agent: "cline", origin: "imported" });
  });
});
