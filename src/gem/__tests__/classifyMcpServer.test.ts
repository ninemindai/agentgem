import { describe, it, expect } from "vitest";
import { classifyMcpServer } from "@agentgem/model";

describe("classifyMcpServer", () => {
  it("classifies a public npx server as a package reference", () => {
    const a = classifyMcpServer("context7", { command: "npx", args: ["-y", "@modelcontextprotocol/server-context7"] });
    expect(a).toMatchObject({ type: "reference", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } });
  });

  it("redacts secret-bearing fields (env is never part of the resulting config)", () => {
    const a = classifyMcpServer("local", { command: "node", args: ["./x.js"] });
    expect(JSON.stringify(a)).not.toContain("secret");
    expect(a).toMatchObject({ type: "mcp_server", transport: "stdio", config: { command: "node", args: ["./x.js"] } });
  });

  it("classifies a url server as http transport with only { url } in config", () => {
    const a = classifyMcpServer("remote", { url: "https://example.com/mcp" });
    expect(a).toMatchObject({ type: "mcp_server", transport: "http" });
    if (a.type === "mcp_server") expect(a.config).toEqual({ url: "https://example.com/mcp" });
  });
});
