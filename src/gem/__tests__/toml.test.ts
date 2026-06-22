// src/gem/__tests__/toml.test.ts
import { describe, it, expect } from "vitest";
import { tomlMcpServers, parseTomlMcpServers } from "../toml.js";
import type { McpServerArtifact } from "../types.js";

const srv = (name: string, config: Record<string, unknown>): McpServerArtifact => ({ type: "mcp_server", name, transport: "stdio", config });

describe("tomlMcpServers", () => {
  it("renders a server table with command, args array, and an env sub-table", () => {
    const t = tomlMcpServers([srv("github", { command: "npx", args: ["-y", "gh"], env: { GH_TOKEN: "<redacted>", REGION: "us" } })]);
    expect(t).toContain("[mcp_servers.github]");
    expect(t).toContain('command = "npx"');
    expect(t).toContain('args = ["-y", "gh"]');
    expect(t).toContain("[mcp_servers.github.env]");
    expect(t).toContain('GH_TOKEN = "<redacted>"');
    expect(t).toContain('REGION = "us"');
  });

  it("quotes non-bareword server names and escapes special chars in strings", () => {
    const t = tomlMcpServers([srv("weird name", { command: 'a"b\\c' })]);
    expect(t).toContain('[mcp_servers."weird name"]');
    expect(t).toContain('command = "a\\"b\\\\c"');
  });

  it("returns empty string for no servers", () => {
    expect(tomlMcpServers([])).toBe("");
  });
});

describe("parseTomlMcpServers", () => {
  it("round-trips the shape tomlMcpServers writes", () => {
    const servers: McpServerArtifact[] = [
      { type: "mcp_server", name: "gh", transport: "stdio", config: { command: "npx", args: ["-y", "gh-mcp"], env: { GH_TOKEN: "x" } } },
      { type: "mcp_server", name: "exa", transport: "http", config: { url: "https://mcp.x/sse" } },
    ];
    const parsed = parseTomlMcpServers(tomlMcpServers(servers));
    expect(parsed.gh).toEqual({ command: "npx", args: ["-y", "gh-mcp"], env: { GH_TOKEN: "x" } });
    expect(parsed.exa).toEqual({ url: "https://mcp.x/sse" });
  });
  it("returns {} for input without an [mcp_servers] table", () => {
    expect(parseTomlMcpServers('[other]\nx = 1\n')).toEqual({});
  });
});
