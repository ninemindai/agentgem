import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldTestbed } from "../testbed.js";

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
