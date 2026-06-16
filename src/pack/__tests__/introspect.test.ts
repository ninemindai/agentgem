// src/pack/__tests__/introspect.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { introspectConfig } from "../introspect.js";

let dir: string;
let agentDir: string;
let codexDir: string;

function skill(root: string, name: string, body: string) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), body);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfg-"));
  agentDir = mkdtempSync(join(tmpdir(), "agent-"));
  codexDir = mkdtempSync(join(tmpdir(), "codex-"));

  skill(join(dir, "skills"), "review", "---\nname: review\ndescription: Review code\n---\nbody");
  skill(join(dir, "skills"), "secret-skill", "---\nname: secret-skill\nmetadata:\n  internal: true\n---\nhidden");

  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      mcpServers: { user1: { command: "x", env: { TOK: "secretval" } } },
      enabledPlugins: { "p@mp": true },
    }),
  );

  const pPath = join(dir, "plugins", "p");
  const qPath = join(dir, "plugins", "q");
  mkdirSync(join(dir, "plugins"), { recursive: true });
  mkdirSync(pPath, { recursive: true });
  mkdirSync(qPath, { recursive: true });
  writeFileSync(
    join(dir, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 1, plugins: { "p@mp": [{ installPath: pPath }], "q@mp": [{ installPath: qPath }] } }),
  );
  writeFileSync(join(pPath, ".mcp.json"), JSON.stringify({ psrv: { command: "go", env: { KEY: "sekret" } } }));
  skill(join(pPath, "skills"), "pskill", "---\nname: pskill\ndescription: Plugin skill\n---\nx");
  skill(join(pPath, "skills"), "review", "---\nname: review\ndescription: PLUGIN review\n---\ndup");
  writeFileSync(join(qPath, ".mcp.json"), JSON.stringify({ qsrv: { command: "no" } }));

  writeFileSync(join(dir, "CLAUDE.md"), "global instructions");
  skill(agentDir, "agentskill", "---\nname: agentskill\ndescription: From agent dir\n---\nz");

  // codex: a skill + a rules file
  skill(join(codexDir, "skills"), "codexskill", "---\nname: codexskill\ndescription: From codex\n---\nc");
  mkdirSync(join(codexDir, "rules"), { recursive: true });
  writeFileSync(join(codexDir, "rules", "default.rules"), "codex rules body");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(codexDir, { recursive: true, force: true });
});

describe("introspectConfig (multi-source)", () => {
  it("collects skills from standalone, plugin, and agent sources with source tags; skips internal; dedups by name", () => {
    const inv = introspectConfig({ claudeDir: dir, agentDir, codexDir });
    const byName = Object.fromEntries(inv.skills.map((s) => [s.name, s]));
    expect(byName["secret-skill"]).toBeUndefined();
    expect(inv.skills.filter((s) => s.name === "review").length).toBe(1);
    expect(byName["review"].source).toBe("standalone");
    expect(byName["review"].description).toBe("Review code");
    expect(byName["pskill"].source).toBe("plugin:p@mp");
    expect(byName["agentskill"].source).toBe("agent");
  });

  it("collects MCP servers from user + enabled plugin (.mcp.json bare map), redacted, sourced; skips disabled plugins", () => {
    const inv = introspectConfig({ claudeDir: dir, agentDir, codexDir });
    const byName = Object.fromEntries(inv.mcpServers.map((m) => [m.name, m]));
    expect((byName["user1"].config.env as Record<string, string>).TOK).toBe("<redacted>");
    expect(byName["user1"].source).toBe("user");
    expect((byName["psrv"].config.env as Record<string, string>).KEY).toBe("<redacted>");
    expect(byName["psrv"].source).toBe("plugin:p@mp");
    expect(byName["qsrv"]).toBeUndefined();
    expect(JSON.stringify(inv)).not.toContain("sekret");
    expect(JSON.stringify(inv)).not.toContain("secretval");
  });

  it("captures CLAUDE.md and returns empty for missing dirs", () => {
    const inv = introspectConfig({ claudeDir: dir, agentDir, codexDir });
    expect(inv.instructions.find((i) => i.name === "CLAUDE.md")?.content).toBe("global instructions");
    const empty = introspectConfig({
      claudeDir: join(dir, "nope"),
      agentDir: join(agentDir, "nope"),
      codexDir: join(codexDir, "nope"),
    });
    expect(empty).toEqual({ skills: [], mcpServers: [], instructions: [] });
  });

  it("collects codex skills (source 'codex') and codex rules files as instructions", () => {
    const inv = introspectConfig({ claudeDir: dir, agentDir, codexDir });
    const byName = Object.fromEntries(inv.skills.map((s) => [s.name, s]));
    expect(byName["codexskill"].source).toBe("codex");
    const rules = inv.instructions.find((i) => i.name === "codex:rules/default.rules");
    expect(rules?.content).toBe("codex rules body");
    // CLAUDE.md still captured alongside codex rules
    expect(inv.instructions.some((i) => i.name === "CLAUDE.md")).toBe(true);
  });
});
