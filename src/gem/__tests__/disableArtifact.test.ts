import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disableArtifacts, enableArtifacts, listDisabled } from "@agentgem/capture";

let home: string;
let opts: { claudeDir: string; agentDir: string; codexDir: string; hermesDir: string };

// The four skill roots, keyed by source, under one temp home (mirrors introspect defaults).
function rootFor(source: string): string {
  return {
    standalone: join(opts.claudeDir, "skills"),
    agent: opts.agentDir,
    codex: join(opts.codexDir, "skills"),
    hermes: join(opts.hermesDir, "skills"),
  }[source]!;
}
function seedSkill(source: string, name: string, body = "SKILL.md") {
  const dir = join(rootFor(source), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, body), `---\ndescription: ${name}\n---\n# ${name}`);
}
const archiveSkill = (source: string, name: string) => join(home, ".agentgem", "disabled", "skills", source, name);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "disable-"));
  opts = {
    claudeDir: join(home, ".claude"),
    agentDir: join(home, ".agents", "skills"),
    codexDir: join(home, ".codex"),
    hermesDir: join(home, ".hermes"),
  };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("disableArtifacts / enableArtifacts — skills", () => {
  it("round-trips a skill for every agent source", () => {
    for (const [source, body] of [["standalone", "SKILL.md"], ["agent", "SKILL.md"], ["codex", "SKILL.md"], ["hermes", "DESCRIPTION.md"]] as const) {
      seedSkill(source, "demo", body);
      const [d] = disableArtifacts([{ type: "skill", name: "demo", source }], opts);
      expect(d.ok).toBe(true);
      expect(existsSync(join(rootFor(source), "demo"))).toBe(false);   // gone from live root
      expect(existsSync(join(archiveSkill(source, "demo"), body))).toBe(true); // archived, folder intact
      const [e] = enableArtifacts([{ type: "skill", name: "demo", source }], opts);
      expect(e.ok).toBe(true);
      expect(existsSync(join(rootFor(source), "demo", body))).toBe(true); // restored
      expect(existsSync(archiveSkill(source, "demo"))).toBe(false);
    }
  });

  it("keeps same-named skills from different agents in distinct archive namespaces", () => {
    seedSkill("standalone", "dup"); seedSkill("codex", "dup");
    disableArtifacts([{ type: "skill", name: "dup", source: "standalone" }, { type: "skill", name: "dup", source: "codex" }], opts);
    expect(existsSync(archiveSkill("standalone", "dup"))).toBe(true);
    expect(existsSync(archiveSkill("codex", "dup"))).toBe(true);
    const disabled = listDisabled(opts);
    expect(disabled.filter((d) => d.type === "skill" && d.name === "dup")).toHaveLength(2);
  });

  it("rejects a traversal name without moving anything", () => {
    const [r] = disableArtifacts([{ type: "skill", name: "../evil", source: "standalone" }], opts);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/invalid/i);
    expect(existsSync(join(home, ".agentgem"))).toBe(false);
  });

  it("fails cleanly when the archive target already exists (no clobber)", () => {
    seedSkill("standalone", "demo");
    mkdirSync(archiveSkill("standalone", "demo"), { recursive: true }); // pre-existing archive
    const [r] = disableArtifacts([{ type: "skill", name: "demo", source: "standalone" }], opts);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already archived/i);
    expect(existsSync(join(rootFor("standalone"), "demo"))).toBe(true); // untouched
  });

  it("processes the rest of a batch when one item is bad", () => {
    seedSkill("standalone", "good");
    const res = disableArtifacts([
      { type: "skill", name: "missing", source: "standalone" },
      { type: "skill", name: "good", source: "standalone" },
    ], opts);
    expect(res[0].ok).toBe(false);
    expect(res[1].ok).toBe(true);
  });
});

describe("plugin disable/enable", () => {
  const settingsFile = () => join(opts.claudeDir, "settings.json");
  const readSettings = () => JSON.parse(readFileSync(settingsFile(), "utf8"));

  beforeEach(() => {
    mkdirSync(opts.claudeDir, { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ enabledPlugins: { "brooks-lint": true }, someOther: 1 }));
  });

  it("disables a plugin-sourced row by flipping the flag, preserving other keys", () => {
    const [r] = disableArtifacts([{ type: "skill", name: "brooks-review", source: "plugin:brooks-lint" }], opts);
    expect(r.ok).toBe(true);
    const s = readSettings();
    expect(s.enabledPlugins["brooks-lint"]).toBe(false);
    expect(s.someOther).toBe(1); // untouched
  });

  it("lists a disabled plugin and re-enables it", () => {
    disableArtifacts([{ type: "skill", name: "brooks-review", source: "plugin:brooks-lint" }], opts);
    const disabled = listDisabled(opts);
    expect(disabled).toContainEqual({ type: "plugin", name: "brooks-lint", source: "plugin:brooks-lint" });
    const [e] = enableArtifacts([{ type: "plugin", name: "brooks-lint", source: "plugin:brooks-lint" }], opts);
    expect(e.ok).toBe(true);
    expect(readSettings().enabledPlugins["brooks-lint"]).toBe(true);
  });
});

describe("mcp disable/enable", () => {
  const settingsFile = () => join(opts.claudeDir, "settings.json");
  const mcpJsonFile = () => join(opts.claudeDir, ".mcp.json");
  const readSettings = () => JSON.parse(readFileSync(settingsFile(), "utf8"));
  const stashFile = (name: string) => join(home, ".agentgem", "disabled", "mcp", `${name}.json`);

  beforeEach(() => mkdirSync(opts.claudeDir, { recursive: true }));

  it("stashes and restores a settings.json-defined MCP server", () => {
    writeFileSync(settingsFile(), JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["gh-mcp"] } } }));
    const [d] = disableArtifacts([{ type: "mcp", name: "gh", source: "user" }], opts);
    expect(d.ok).toBe(true);
    expect(readSettings().mcpServers.gh).toBeUndefined();          // removed from live config
    expect(JSON.parse(readFileSync(stashFile("gh"), "utf8")).config.args).toEqual(["gh-mcp"]); // stashed
    expect(listDisabled(opts)).toContainEqual({ type: "mcp", name: "gh", source: "user" });
    const [e] = enableArtifacts([{ type: "mcp", name: "gh", source: "user" }], opts);
    expect(e.ok).toBe(true);
    expect(readSettings().mcpServers.gh.args).toEqual(["gh-mcp"]); // restored
    expect(existsSync(stashFile("gh"))).toBe(false);              // stash cleaned up
  });

  it("toggles disabledMcpjsonServers for a .mcp.json-defined server", () => {
    writeFileSync(settingsFile(), JSON.stringify({}));
    writeFileSync(mcpJsonFile(), JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["fs-mcp"] } } }));
    const [d] = disableArtifacts([{ type: "mcp", name: "fs", source: "user" }], opts);
    expect(d.ok).toBe(true);
    expect(readSettings().disabledMcpjsonServers).toContain("fs");
    expect(listDisabled(opts)).toContainEqual({ type: "mcp", name: "fs", source: "user" });
    const [e] = enableArtifacts([{ type: "mcp", name: "fs", source: "user" }], opts);
    expect(e.ok).toBe(true);
    expect(readSettings().disabledMcpjsonServers).not.toContain("fs");
  });

  it("fails cleanly for an MCP name in neither config", () => {
    writeFileSync(settingsFile(), JSON.stringify({}));
    const [r] = disableArtifacts([{ type: "mcp", name: "ghost", source: "user" }], opts);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not found/i);
  });
});
