import { describe, it, expect } from "vitest";
import { materialize } from "@agentgem/model";
import type { Gem } from "@agentgem/model";

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
});
