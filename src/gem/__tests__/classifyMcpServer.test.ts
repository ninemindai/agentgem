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

  it("strips query/credentials from a server url, keeping only origin + pathname", () => {
    const a = classifyMcpServer("remote", { url: "https://user:pw@example.com/mcp?api_key=sk-live-123#frag" });
    if (a.type === "mcp_server") {
      const cfg = a.config as { url: string };
      expect(cfg.url).toBe("https://example.com/mcp");
      expect(cfg.url).not.toContain("api_key");
      expect(cfg.url).not.toContain("sk-live-123");
    } else throw new Error("expected mcp_server");
  });

  it("leaves a normal url unchanged (no query/credentials to strip)", () => {
    const a = classifyMcpServer("remote", { url: "https://example.com/mcp" });
    if (a.type === "mcp_server") expect((a.config as { url: string }).url).toBe("https://example.com/mcp");
  });

  it("redacts the value following a secret-shaped flag (--api-key <value>)", () => {
    const a = classifyMcpServer("local", { command: "node", args: ["./x.js", "--api-key", "sk-live-123"] });
    if (a.type === "mcp_server") {
      const cfg = a.config as { args: unknown[] };
      expect(cfg.args).toEqual(["./x.js", "--api-key", "<redacted>"]);
    } else throw new Error("expected mcp_server");
  });

  it("redacts a self-contained key=value secret arg", () => {
    const a = classifyMcpServer("local", { command: "node", args: ["token=abc"] });
    if (a.type === "mcp_server") {
      const cfg = a.config as { args: unknown[] };
      expect(cfg.args[0]).toBe("token=<redacted>");
    } else throw new Error("expected mcp_server");
  });

  it("leaves normal (non-secret) args unchanged", () => {
    const a = classifyMcpServer("local", { command: "node", args: ["./x.js", "--verbose"] });
    if (a.type === "mcp_server") expect((a.config as { args: unknown[] }).args).toEqual(["./x.js", "--verbose"]);
  });
});
