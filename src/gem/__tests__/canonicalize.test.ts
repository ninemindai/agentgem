// src/gem/__tests__/canonicalize.test.ts
import { describe, it, expect } from "vitest";
import { canonicalMcpServer, canonicalSkill, canonicalModel, canonicalHarness, CANONICALIZER_VERSION } from "../canonicalize.js";

describe("canonicalize", () => {
  it("maps a public npx package server to a stable public id regardless of local name", () => {
    const a = canonicalMcpServer({ type: "mcp_server", name: "my-github", transport: "stdio",
      config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } });
    const b = canonicalMcpServer({ type: "mcp_server", name: "gh", transport: "stdio",
      config: { command: "npx", args: ["@modelcontextprotocol/server-github"] } });
    expect(a).toEqual({ id: "npx:@modelcontextprotocol/server-github", idKind: "package", public: true });
    expect(b.id).toBe(a.id);
  });

  it("salts a private path-based stdio server and marks it non-public", () => {
    const r = canonicalMcpServer({ type: "mcp_server", name: "internal", transport: "stdio",
      config: { command: "node", args: ["/Users/x/secret/server.js"] } });
    expect(r.idKind).toBe("private");
    expect(r.public).toBe(false);
    expect(r.id.startsWith("private:sha256:")).toBe(true);
  });

  it("uses public http host+path, salts private/localhost", () => {
    expect(canonicalMcpServer({ type: "mcp_server", name: "x", transport: "http",
      config: { url: "https://api.example.com/mcp" } })).toEqual({ id: "url:api.example.com/mcp", idKind: "url", public: true });
    expect(canonicalMcpServer({ type: "mcp_server", name: "x", transport: "http",
      config: { url: "http://127.0.0.1:8080/mcp" } }).public).toBe(false);
  });

  it("skill prefers registry coord, falls back to content hash", () => {
    expect(canonicalSkill({ type: "skill", name: "qa", source: "@acme/qa", content: "x" }))
      .toEqual({ id: "@acme/qa", idKind: "registry", public: true });
    const h = canonicalSkill({ type: "skill", name: "qa", source: "standalone", content: "BODY" });
    expect(h.idKind).toBe("contentHash");
    expect(h.id.startsWith("skill:sha256:")).toBe(true);
    expect(h.public).toBe(false);
  });

  it("model and harness are known + public", () => {
    expect(canonicalModel("Claude-Opus-4-8")).toEqual({ id: "claude-opus-4-8", idKind: "known", public: true });
    expect(canonicalHarness("claude")).toEqual({ id: "claude-code", idKind: "known", public: true });
  });

  it("exposes a version", () => { expect(CANONICALIZER_VERSION).toBe(1); });
});
