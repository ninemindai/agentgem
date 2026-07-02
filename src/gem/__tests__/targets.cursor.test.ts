import { describe, it, expect } from "vitest";
import { materialize } from "@agentgem/model";
import type { Gem } from "@agentgem/model";

const gem: Gem = { name: "g", createdFrom: "t", checks: [], requiredSecrets: [], artifacts: [
  { type: "instructions", name: "style", content: "Prefer small diffs." },
  { type: "mcp_server", name: "local", transport: "stdio", config: { command: "node", args: ["s.js"] } },
  { type: "reference", name: "context7", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } },
] };

describe("cursor target", () => {
  it("writes .cursor/rules/*.mdc (with frontmatter) and .cursor/mcp.json (ref as npx)", () => {
    const { files } = materialize(gem, "cursor");
    const mdc = files[".cursor/rules/style.mdc"];
    expect(mdc).toContain("alwaysApply: true");
    expect(mdc).toContain("Prefer small diffs.");
    const mcp = JSON.parse(files[".cursor/mcp.json"]);
    expect(mcp.mcpServers.local).toMatchObject({ command: "node", args: ["s.js"] });
    expect(mcp.mcpServers.context7).toMatchObject({ command: "npx", args: ["@modelcontextprotocol/server-context7"] });
  });
});
