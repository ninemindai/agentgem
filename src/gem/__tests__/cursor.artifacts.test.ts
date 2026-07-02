// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCursorArtifacts } from "@agentgem/insight";

describe("Cursor artifact import", () => {
  it("imports .mdc rules (frontmatter stripped) + mcp.json object-map (ref/redacted)", async () => {
    const base = mkdtempSync(join(tmpdir(), "cursor-a-"));
    const rulesDir = join(base, ".cursor", "rules"); mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "style.mdc"), "---\ndescription: style\nglobs: \"*.ts\"\nalwaysApply: true\n---\nPrefer small diffs.");
    writeFileSync(join(base, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {
      context7: { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] },
      local: { command: "node", args: ["./s.js"], env: { TOKEN: "secret" } },
    } }));
    const { artifacts, binding } = await readCursorArtifacts({ rulesDir, mcpFile: join(base, ".cursor", "mcp.json") });
    const instr = artifacts.find((a) => a.type === "instructions");
    expect(instr).toMatchObject({ name: "style", content: "Prefer small diffs." }); // frontmatter stripped
    expect(artifacts.find((a) => a.type === "reference")).toMatchObject({ ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } });
    const local = artifacts.find((a) => a.type === "mcp_server");
    expect(JSON.stringify(local)).not.toContain("secret");
    expect(binding).toMatchObject({ agent: "cursor", origin: "imported" });
  });
});
