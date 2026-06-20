import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldTestbed, importArtifacts } from "../testbed.js";
import type { ConfigInventory } from "../types.js";

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
