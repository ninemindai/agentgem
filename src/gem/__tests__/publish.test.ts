// src/gem/__tests__/publish.test.ts
import { describe, it, expect } from "vitest";
import { renderManagedAgent, MANAGED_AGENTS_MODEL } from "../publish.js";
import type { Gem } from "../types.js";

const gem: Gem = {
  name: "mygem",
  createdFrom: "/home/.claude",
  checks: [],
  requiredSecrets: [{ name: "GH_TOKEN", artifact: "github", location: "headers.Authorization" }],
  artifacts: [
    { type: "skill", name: "review", source: "standalone", content: "# Review\nbody" },
    { type: "skill", name: "deploy", source: "standalone", content: "# Deploy" },
    // http MCP with a redacted secret -> maps to mcp_servers (url kept, token already <redacted>)
    { type: "mcp_server", name: "github", transport: "http", source: "plugin:gh", config: { url: "https://mcp.github.com/mcp", headers: { Authorization: "<redacted>" } }, secretRefs: [{ name: "GH_TOKEN", location: "headers.Authorization" }] },
    // stdio MCP -> skipped (no URL endpoint)
    { type: "mcp_server", name: "local", transport: "stdio", source: "user", config: { command: "npx", args: ["x"] } },
    // hook -> skipped
    { type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", matcher: "Bash", config: { hooks: [] }, source: "user" },
    { type: "instructions", name: "CLAUDE.md", content: "be careful" },
    { type: "instructions", name: "SOUL.md", content: "be kind" },
  ],
};

describe("renderManagedAgent", () => {
  it("instructions->system, skills->skillsToRegister (not inlined), maps http MCP, default model", () => {
    const r = renderManagedAgent(gem);
    expect(r.payload.model).toBe(MANAGED_AGENTS_MODEL);
    expect(r.payload.name).toBe("mygem");
    expect(r.payload.system).toContain("## CLAUDE.md");
    expect(r.payload.system).toContain("be kind");        // instruction files
    expect(r.payload.system).not.toContain("# Skill:");   // skills are NOT inlined anymore
    expect(r.skillsToRegister.map((s) => s.name)).toEqual(["review", "deploy"]);
    expect(r.skillsToRegister[0].content).toContain("# Review");
    expect(r.payload.mcp_servers).toEqual([{ type: "url", name: "github", url: "https://mcp.github.com/mcp" }]);
    expect(r.payload.tools).toEqual([
      { type: "agent_toolset_20260401" },
      { type: "mcp_toolset", mcp_server_name: "github" },
    ]);
  });

  it("skips stdio MCP and hooks with reasons", () => {
    const r = renderManagedAgent(gem);
    const byArtifact = Object.fromEntries(r.skipped.map((s) => [s.artifact, s]));
    expect(byArtifact["local"].reason).toMatch(/stdio MCP unsupported/);
    expect(byArtifact["local"].type).toBe("mcp_server");
    expect(byArtifact["PreToolUse · Bash"].reason).toMatch(/no Managed Agents equivalent/);
    expect(byArtifact["PreToolUse · Bash"].type).toBe("hook");
  });

  it("surfaces requiredSecrets as vault secrets (names only) and sends no auth inline", () => {
    const r = renderManagedAgent(gem);
    expect(r.vaultSecrets).toEqual([{ name: "GH_TOKEN", artifact: "github", location: "headers.Authorization" }]);
    // the mcp_servers entry carries ONLY url — no headers/config/auth ever goes in the agent payload
    expect(Object.keys(r.payload.mcp_servers[0]).sort()).toEqual(["name", "type", "url"]);
    // no secret value (not even the <redacted> placeholder) anywhere in the render
    expect(JSON.stringify(r)).not.toContain("<redacted>");
    expect(JSON.stringify(r)).not.toMatch(/ghp_|Bearer [A-Za-z0-9]/);
  });

  it("skips an http MCP whose url was redacted/malformed (never ships a broken endpoint)", () => {
    const p: Gem = { ...gem, artifacts: [
      { type: "mcp_server", name: "bad", transport: "http", source: "user", config: { url: "<redacted>" } },
    ] };
    const r = renderManagedAgent(p);
    expect(r.payload.mcp_servers).toEqual([]);
    expect(r.skipped.find((s) => s.artifact === "bad")?.reason).toMatch(/not a usable https endpoint/);
  });

  it("enforces the 20-skill cap (overflow skipped)", () => {
    const many: Gem = { ...gem, artifacts: Array.from({ length: 22 }, (_, i) => ({ type: "skill" as const, name: `s${i}`, source: "standalone", content: "x" })) };
    const r = renderManagedAgent(many);
    expect(r.skillsToRegister).toHaveLength(20);
    expect(r.skipped.filter((s) => s.reason.includes("20-skill cap"))).toHaveLength(2);
  });

  it("skips duplicate MCP names instead of sending an API-invalid payload", () => {
    const duplicate = gem.artifacts.find((a) => a.type === "mcp_server" && a.name === "github")!;
    const r = renderManagedAgent({ ...gem, artifacts: [...gem.artifacts, duplicate] });
    expect(r.payload.mcp_servers.filter((m) => m.name === "github")).toHaveLength(1);
    expect(r.skipped.find((s) => s.reason.includes("duplicate"))?.artifact).toBe("github");
  });
});
