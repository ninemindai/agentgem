import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GemController } from "../../gem.controller.js";

let home: string, claudeDir: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "uglobal-"));
  claudeDir = join(home, ".claude");
  // a GLOBAL skill (lives under claudeDir/skills) used across two projects
  const gskill = join(claudeDir, "skills", "diagram");
  mkdirSync(gskill, { recursive: true });
  writeFileSync(join(gskill, "SKILL.md"), "---\nname: diagram\ndescription: d\n---\nbody");
  const tu = (skill: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill } }] } });
  // project A: 2x diagram + 1x a project-only skill "localthing" (no global SKILL.md)
  const a = join(claudeDir, "projects", "encA"); mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "a.jsonl"), [JSON.stringify({ cwd: "/projA" }), tu("diagram"), tu("diagram"), tu("localthing")].join("\n") + "\n");
  // project B: 3x diagram
  const b = join(claudeDir, "projects", "encB"); mkdirSync(b, { recursive: true });
  writeFileSync(join(b, "b.jsonl"), [JSON.stringify({ cwd: "/projB" }), tu("diagram"), tu("diagram"), tu("diagram")].join("\n") + "\n");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("GET /api/usage?scope=global", () => {
  it("aggregates a global skill across all projects", async () => {
    const res = await new GemController().usage({ query: { dir: claudeDir, scope: "global" } });
    const diagram = res.artifacts.find((a) => a.type === "skill" && a.name === "diagram");
    expect(diagram).toBeTruthy();
    expect(diagram!.invocations).toBe(5);     // 2 (A) + 3 (B)
    expect(diagram!.root).toBeNull();
  });
  it("excludes project-only skills not in the global inventory", async () => {
    const res = await new GemController().usage({ query: { dir: claudeDir, scope: "global" } });
    expect(res.artifacts.find((a) => a.name === "localthing")).toBeFalsy();
  });
  it("returns empty (no throw) when there are no transcripts", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ugempty-"));
    const res = await new GemController().usage({ query: { dir: join(empty, ".claude"), scope: "global" } });
    expect(res.artifacts).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});
