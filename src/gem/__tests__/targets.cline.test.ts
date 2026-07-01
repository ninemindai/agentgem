import { describe, it, expect } from "vitest";
import { materialize } from "@agentgem/model";
import type { Gem } from "@agentgem/model";

const gem: Gem = { name: "g", createdFrom: "t", checks: [], requiredSecrets: [], artifacts: [
  { type: "instructions", name: "rules", content: "Test first." },
  { type: "mcp_server", name: "local", transport: "stdio", config: { command: "node", args: ["s.js"] } },
  { type: "reference", name: "context7", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } },
] };

describe("cline target", () => {
  it("writes .clinerules and cline_mcp_settings.json, keeping the package ref as an npx command", () => {
    const { files } = materialize(gem, "cline");
    expect(files[".clinerules"]).toBe("Test first.");
    const mcp = JSON.parse(files["cline_mcp_settings.json"]);
    expect(mcp.mcpServers.local).toMatchObject({ command: "node", args: ["s.js"] });
    expect(mcp.mcpServers.context7).toMatchObject({ command: "npx", args: ["@modelcontextprotocol/server-context7"] });
  });
});
