// src/pack/__tests__/introspectProject.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { introspectProject } from "../introspect.js";

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
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("introspectProject", () => {
  it("discovers project skills/mcp/instructions tagged source 'project', redacted", () => {
    const p = introspectProject(root);
    expect(p.root).toBe(root);
    const sk = Object.fromEntries(p.skills.map((s) => [s.name, s]));
    expect(sk["deploy"].source).toBe("project");
    expect(sk["lint"].source).toBe("project");
    const m = Object.fromEntries(p.mcpServers.map((x) => [x.name, x]));
    expect(m["db"].source).toBe("project");
    expect((m["db"].config.env as Record<string, string>).PW).toBe("<redacted>");
    expect(JSON.stringify(p)).not.toContain("topsecret");
    expect(p.instructions.map((i) => i.name).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("returns empty arrays for a root with no project artifacts", () => {
    const nope = join(root, "nope");
    expect(introspectProject(nope)).toEqual({ root: nope, skills: [], mcpServers: [], instructions: [] });
  });
});
