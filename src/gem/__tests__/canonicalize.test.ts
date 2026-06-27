// src/gem/__tests__/canonicalize.test.ts
import { describe, it, expect } from "vitest";
import { canonicalMcpServer, canonicalSkill, canonicalModel, canonicalHarness, CANONICALIZER_VERSION } from "../canonicalize.js";

describe("canonicalize", () => {
  it("maps a public npx package server to a stable public id regardless of local name", () => {
    const a = canonicalMcpServer({ type: "mcp_server", name: "my-github", transport: "stdio",
      config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } }, "S");
    const b = canonicalMcpServer({ type: "mcp_server", name: "gh", transport: "stdio",
      config: { command: "npx", args: ["@modelcontextprotocol/server-github"] } }, "S");
    expect(a).toEqual({ id: "npx:@modelcontextprotocol/server-github", idKind: "package", public: true });
    expect(b.id).toBe(a.id);
  });

  it("salts a private path-based stdio server and marks it non-public", () => {
    const r = canonicalMcpServer({ type: "mcp_server", name: "internal", transport: "stdio",
      config: { command: "node", args: ["/Users/x/secret/server.js"] } }, "S");
    expect(r.idKind).toBe("private");
    expect(r.public).toBe(false);
    expect(r.id.startsWith("private:sha256:")).toBe(true);
  });

  it("uses public http hostname only (no path), salts private/localhost", () => {
    expect(canonicalMcpServer({ type: "mcp_server", name: "x", transport: "http",
      config: { url: "https://api.example.com/mcp" } }, "S")).toEqual({ id: "url:api.example.com", idKind: "url", public: true });
    expect(canonicalMcpServer({ type: "mcp_server", name: "x", transport: "http",
      config: { url: "http://127.0.0.1:8080/mcp" } }, "S").public).toBe(false);
  });

  it("skill with public-scope source returns registry id; non-public scope falls back to content hash", () => {
    // @modelcontextprotocol is allowlisted — would be public if a skill used it
    // @acme is not allowlisted → private content hash
    const privateSkill = canonicalSkill({ type: "skill", name: "qa", source: "@acme/qa", content: "x" }, "S");
    expect(privateSkill.idKind).toBe("contentHash");
    expect(privateSkill.public).toBe(false);
    expect(privateSkill.id.startsWith("skill:sha256:")).toBe(true);
    // Standalone (no scoped source) → content hash
    const h = canonicalSkill({ type: "skill", name: "qa", source: "standalone", content: "BODY" }, "S");
    expect(h.idKind).toBe("contentHash");
    expect(h.id.startsWith("skill:sha256:")).toBe(true);
    expect(h.public).toBe(false);
  });

  it("model and harness are known + public", () => {
    expect(canonicalModel("Claude-Opus-4-8")).toEqual({ id: "claude-opus-4-8", idKind: "known", public: true });
    expect(canonicalHarness("claude")).toEqual({ id: "claude-code", idKind: "known", public: true });
  });

  it("exposes version 2", () => { expect(CANONICALIZER_VERSION).toBe(2); });

  it("classifies cloud-metadata and IPv4-mapped-IPv6 hosts as private", () => {
    expect(canonicalMcpServer({ type: "mcp_server", name: "meta", transport: "http",
      config: { url: "http://169.254.169.254/mcp" } }, "S").public).toBe(false);
    expect(canonicalMcpServer({ type: "mcp_server", name: "v6", transport: "http",
      config: { url: "http://[::ffff:192.168.1.1]/mcp" } }, "S").public).toBe(false);
  });

  // --- regression tests: privacy holes now closed ---

  it("path-runner: basename only — no filesystem path leaks in the id", () => {
    const r = canonicalMcpServer({ type: "mcp_server", name: "x", transport: "stdio",
      config: { command: "/Users/me/bin/uvx", args: ["some-public-pkg"] } }, "S");
    expect(r.id).toBe("uvx:some-public-pkg");
    expect(r.public).toBe(true);
    expect(r.id).not.toContain("/Users");
  });

  it("URL path dropped — PII path segments never appear in the id", () => {
    const r = canonicalMcpServer({ type: "mcp_server", name: "x", transport: "http",
      config: { url: "https://mcp.prod.company.com/users/alice" } }, "S");
    expect(r.id).toBe("url:mcp.prod.company.com");
    expect(r.public).toBe(true);
    expect(r.id).not.toContain("alice");
    expect(r.id).not.toContain("/users");
  });

  it("private scoped package: id is salted hash, scope name never appears", () => {
    const r = canonicalMcpServer({ type: "mcp_server", name: "x", transport: "stdio",
      config: { command: "npx", args: ["@myco/internal-mcp"] } }, "S");
    expect(r.idKind).toBe("private");
    expect(r.public).toBe(false);
    expect(r.id.startsWith("private:sha256:")).toBe(true);
    expect(r.id).not.toContain("myco");
  });

  it("salt determinism: same input + salt → same id; different salt → different id", () => {
    const cfg = { type: "mcp_server" as const, name: "x", transport: "stdio" as const,
      config: { command: "node", args: ["/local/server.js"] } };
    const id1 = canonicalMcpServer(cfg, "salt-A").id;
    const id2 = canonicalMcpServer(cfg, "salt-A").id;
    const id3 = canonicalMcpServer(cfg, "salt-B").id;
    expect(id1).toBe(id2);           // deterministic
    expect(id1).not.toBe(id3);       // different salt → different id
  });
});
