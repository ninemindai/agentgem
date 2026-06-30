// src/gem/__tests__/introspectProject.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { introspectProject } from "@agentgem/capture";

let root: string;
function skill(r: string, name: string, body: string) {
  mkdirSync(join(r, name), { recursive: true });
  writeFileSync(join(r, name, "SKILL.md"), body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "proj-"));
  skill(join(root, ".claude", "skills"), "deploy", "---\nname: deploy\ndescription: Project deploy\n---\nbody");
  skill(join(root, ".agents", "skills"), "lint", "---\nname: lint\ndescription: Project lint\n---\nx");
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ db: { command: "pg", env: { PW: "topsecret" } } }));
  writeFileSync(join(root, "CLAUDE.md"), "project claude");
  writeFileSync(join(root, "AGENTS.md"), "project agents");
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }] } }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("introspectProject", () => {
  it("discovers project skills/mcp/instructions tagged source 'project', redacted", () => {
    const p = introspectProject(root);
    expect(p.root).toBe(root);
    expect(p.name).toBe(root.split("/").pop());
    const sk = Object.fromEntries(p.skills.map((s) => [s.name, s]));
    expect(sk["deploy"].source).toBe("project");
    expect(sk["lint"].source).toBe("project");
    const m = Object.fromEntries(p.mcpServers.map((x) => [x.name, x]));
    expect(m["db"].source).toBe("project");
    expect((m["db"].config.env as Record<string, string>).PW).toBe("<redacted>");
    expect(JSON.stringify(p)).not.toContain("topsecret");
    expect(p.instructions.map((i) => i.name).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
    const hook = p.hooks.find((h) => h.event === "PreToolUse");
    expect(hook?.name).toBe("PreToolUse · Bash");
    expect(hook?.source).toBe("project");
  });

  it("returns empty arrays for a root with no project artifacts", () => {
    const nope = join(root, "nope");
    expect(introspectProject(nope)).toEqual({ root: nope, name: "nope", skills: [], mcpServers: [], instructions: [], hooks: [] });
  });
});

describe("introspectProject — codex/hermes shapes", () => {
  it("reads codex MCP from .codex/config.toml (redacted)", () => {
    const r = mkdtempSync(join(tmpdir(), "cx-"));
    mkdirSync(join(r, ".codex"), { recursive: true });
    writeFileSync(join(r, ".codex", "config.toml"), '[mcp_servers.gh]\ncommand = "npx"\n\n[mcp_servers.gh.env]\nGH_TOKEN = "ghp_realsecret"\n');
    writeFileSync(join(r, "AGENTS.md"), "codex instructions");
    const p = introspectProject(r);
    const gh = p.mcpServers.find((m) => m.name === "gh");
    expect(gh).toBeTruthy();
    expect((gh!.config.env as Record<string, string>).GH_TOKEN).toBe("<redacted>");
    expect(JSON.stringify(p)).not.toContain("ghp_realsecret");
    expect(p.instructions.map((i) => i.name)).toContain("AGENTS.md");
    rmSync(r, { recursive: true, force: true });
  });
  it("reads hermes skills (DESCRIPTION.md) and SOUL.md", () => {
    const r = mkdtempSync(join(tmpdir(), "hm-"));
    mkdirSync(join(r, ".hermes", "skills", "weather"), { recursive: true });
    writeFileSync(join(r, ".hermes", "skills", "weather", "DESCRIPTION.md"), "---\nname: weather\ndescription: w\n---\nbody");
    writeFileSync(join(r, ".hermes", "SOUL.md"), "be kind");
    const p = introspectProject(r);
    expect(p.skills.map((s) => s.name)).toContain("weather");
    expect(p.instructions.map((i) => i.name)).toContain("SOUL.md");
    rmSync(r, { recursive: true, force: true });
  });
});
