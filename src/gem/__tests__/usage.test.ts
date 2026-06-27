import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GemController } from "../../gem.controller.js";

let home: string, projectRoot: string, claudeDir: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "usage-"));
  claudeDir = join(home, ".claude");
  projectRoot = join(home, "proj");
  const skillDir = join(projectRoot, ".claude", "skills", "qa");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: qa\ndescription: qa\n---\nbody");
  const folder = join(claudeDir, "projects", "enc");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "s.jsonl"), [
    JSON.stringify({ cwd: projectRoot }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "qa" } }] } }),
  ].join("\n") + "\n");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("GET /api/usage", () => {
  it("reports invocations + lastUsedMs for a skill that fired", async () => {
    const res = await new GemController().usage({ query: { dir: claudeDir, projects: JSON.stringify([projectRoot]) } });
    const qa = res.artifacts.find((a) => a.type === "skill" && a.name === "qa");
    expect(qa).toBeTruthy();
    expect(qa!.invocations).toBeGreaterThan(0);
    expect(qa!.lastUsedMs).not.toBeNull();
    expect(qa!.sessionsUsedIn).toBe(1);
  });

  it("returns empty artifacts (no throw) when no project is given", async () => {
    const res = await new GemController().usage({ query: {} });
    expect(res.artifacts).toEqual([]);
  });
});
