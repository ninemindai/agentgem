import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldTestbed, importArtifacts } from "../testbed.js";
import type { ConfigInventory } from "../types.js";
import { introspectProject } from "../introspect.js";
import { buildGem } from "../buildGem.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tb-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("scaffoldTestbed", () => {
  it("creates a runnable .claude skeleton with a secret-containing .gitignore", () => {
    const r = scaffoldTestbed(root, "research-agent");
    expect(r.root).toBe(root);
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(root, ".claude", "skills"))).toBe(true);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("# research-agent\n");
    const gi = readFileSync(join(root, ".gitignore"), "utf8");
    expect(gi).toContain(".mcp.json");
    expect(gi).toContain(".claude/settings.json");
    expect(gi).toContain(".env");
    expect(r.created).toContain("CLAUDE.md");
  });

  it("is idempotent — never clobbers existing files", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# hand-edited\n");
    const r = scaffoldTestbed(root, "x");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("# hand-edited\n");
    expect(r.created).not.toContain("CLAUDE.md");
  });
});

function inv(partial: Partial<ConfigInventory>): ConfigInventory {
  return { skills: [], mcpServers: [], instructions: [], hooks: [], ...partial };
}

describe("importArtifacts — skills + instructions", () => {
  it("writes a selected skill verbatim into .claude/skills/<n>/SKILL.md", () => {
    scaffoldTestbed(root, "x");
    const rawInv = inv({ skills: [{ type: "skill", name: "scrape", description: "d", source: "standalone", content: "---\nname: scrape\n---\nbody" }] });
    const r = importArtifacts(root, { skills: ["scrape"] }, rawInv);
    expect(readFileSync(join(root, ".claude", "skills", "scrape", "SKILL.md"), "utf8")).toContain("body");
    expect(r.written).toContainEqual({ type: "skill", name: "scrape", overwritten: false });
  });

  it("appends instructions under an idempotent marker (re-import replaces, not duplicates)", () => {
    scaffoldTestbed(root, "x");
    const rawInv = inv({ instructions: [{ type: "instructions", name: "CLAUDE.md", content: "GLOBAL RULES" }] });
    importArtifacts(root, { includeInstructions: true }, rawInv);
    importArtifacts(root, { includeInstructions: true }, rawInv); // twice
    const body = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(body).toContain("GLOBAL RULES");
    expect(body.match(/agentgem:imported CLAUDE.md/g)?.length).toBe(1); // one block, not two
  });

  it("reports a missing skill in skipped", () => {
    scaffoldTestbed(root, "x");
    const r = importArtifacts(root, { skills: ["nope"] }, inv({}));
    expect(r.skipped).toContainEqual({ artifact: "nope", reason: "not found in global inventory" });
  });
});

describe("importArtifacts — mcp + hooks + containment", () => {
  const rawMcp = inv({ mcpServers: [{ type: "mcp_server", name: "gh", transport: "stdio", config: { command: "npx", env: { GH_TOKEN: "ghp_realsecretvalue" } }, source: "user" }] });

  it("merges raw MCP config into .mcp.json, preserving existing servers", () => {
    scaffoldTestbed(root, "x");
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { keep: { command: "k" } } }));
    const r = importArtifacts(root, { mcpServers: ["gh"] }, rawMcp);
    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.keep).toBeDefined();                 // existing preserved
    expect(mcp.mcpServers.gh.env.GH_TOKEN).toBe("ghp_realsecretvalue"); // raw, so testbed runs
    expect(r.written).toContainEqual({ type: "mcp_server", name: "gh", overwritten: false });
  });

  it("appends a hook group into settings.json without duplicating on re-import", () => {
    scaffoldTestbed(root, "x");
    const rawHook = inv({ hooks: [{ type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", matcher: "Bash", config: { matcher: "Bash", hooks: [{ type: "command", command: "./g.sh" }] }, source: "user" }] });
    importArtifacts(root, { hooks: ["PreToolUse · Bash"] }, rawHook);
    importArtifacts(root, { hooks: ["PreToolUse · Bash"] }, rawHook); // twice
    const s = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    expect(s.hooks.PreToolUse).toHaveLength(1); // deduped
  });

  it("CONTAINMENT: raw secret in testbed, but the packaged Gem is redacted", () => {
    scaffoldTestbed(root, "x");
    importArtifacts(root, { mcpServers: ["gh"] }, rawMcp);
    // package the testbed: introspectProject redacts again
    const proj = introspectProject(root);
    const gem = buildGem({ skills: [], mcpServers: [], instructions: [], hooks: [], projects: [proj] },
      { projects: { [root]: { mcpServers: ["gh"] } } }, { name: "g" });
    expect(JSON.stringify(gem)).not.toContain("ghp_realsecretvalue"); // never leaks into the Gem
    expect(gem.requiredSecrets).toContainEqual({ name: "GH_TOKEN", artifact: "gh", location: "env.GH_TOKEN" });
  });
});
