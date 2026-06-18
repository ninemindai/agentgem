// src/pack/__tests__/publish.test.ts
import { describe, it, expect } from "vitest";
import { renderManagedAgent, MANAGED_AGENTS_MODEL } from "../publish.js";
import type { Pack } from "../types.js";

const pack: Pack = {
  name: "mypack",
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
  it("maps instructions->system, http MCP->mcp_servers, skills->skillBodies; default model", () => {
    const r = renderManagedAgent(pack);
    expect(r.payload.model).toBe(MANAGED_AGENTS_MODEL);
    expect(r.payload.name).toBe("mypack");
    expect(r.payload.system).toContain("## CLAUDE.md");
    expect(r.payload.system).toContain("be kind"); // both instruction files concatenated
    expect(r.skillBodies.map((s) => s.name)).toEqual(["review", "deploy"]);
    expect(r.payload.skills.map((s) => s.name)).toEqual(["review", "deploy"]);
    expect(r.payload.mcp_servers).toEqual([{ type: "url", name: "github", url: "https://mcp.github.com/mcp" }]);
    // tools: agent toolset + an mcp_toolset per mapped server
    expect(r.payload.tools).toEqual([
      { type: "agent_toolset_20260401" },
      { type: "mcp_toolset", mcp_server_name: "github" },
    ]);
  });

  it("skips stdio MCP and hooks with reasons", () => {
    const r = renderManagedAgent(pack);
    const byArtifact = Object.fromEntries(r.skipped.map((s) => [s.artifact, s]));
    expect(byArtifact["local"].reason).toMatch(/stdio MCP unsupported/);
    expect(byArtifact["local"].type).toBe("mcp_server");
    expect(byArtifact["PreToolUse · Bash"].reason).toMatch(/no Managed Agents equivalent/);
    expect(byArtifact["PreToolUse · Bash"].type).toBe("hook");
  });

  it("surfaces requiredSecrets as vault secrets (names only) and sends no auth inline", () => {
    const r = renderManagedAgent(pack);
    expect(r.vaultSecrets).toEqual([{ name: "GH_TOKEN", artifact: "github", location: "headers.Authorization" }]);
    // the mcp_servers entry carries ONLY url — no headers/config/auth ever goes in the agent payload
    expect(Object.keys(r.payload.mcp_servers[0]).sort()).toEqual(["name", "type", "url"]);
    // no secret value (not even the <redacted> placeholder) anywhere in the render
    expect(JSON.stringify(r)).not.toContain("<redacted>");
    expect(JSON.stringify(r)).not.toMatch(/ghp_|Bearer [A-Za-z0-9]/);
  });

  it("enforces the 20-skill cap", () => {
    const many: Pack = { ...pack, artifacts: Array.from({ length: 22 }, (_, i) => ({ type: "skill" as const, name: `s${i}`, source: "standalone", content: "x" })) };
    const r = renderManagedAgent(many);
    expect(r.skillBodies).toHaveLength(20);
    expect(r.skipped.filter((s) => s.reason.includes("20-skill cap"))).toHaveLength(2);
  });
});
