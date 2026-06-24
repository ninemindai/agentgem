// src/gem/__tests__/workflowAnalyze.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GemController } from "../../gem.controller.js";
import { setConnectFnForTests } from "../acpRecommender.js";

let home: string, projectRoot: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "wfctl-"));
  const claudeDir = join(home, ".claude");
  projectRoot = join(home, "proj");
  // a project skill so the inventory has something to recommend
  const skillDir = join(projectRoot, ".claude", "skills", "qa");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: qa\ndescription: qa\n---\nbody");
  // a transcript whose cwd is projectRoot and which invokes Skill(qa)
  const folder = join(claudeDir, "projects", "enc");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "s.jsonl"), [
    JSON.stringify({ cwd: projectRoot }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "qa" } }] } }),
  ].join("\n") + "\n");

  setConnectFnForTests(async () => ({
    ctx: {
      async open() {
        return {
          async setMode() {},
          async promptText() { return JSON.stringify({ name: "QA", description: "d", includeInstructions: false, include: [{ type: "skill", name: "qa", reason: "used" }], confidence: "high" }); },
          dispose() {},
        };
      },
    },
    close() {},
  }));
});
afterAll(() => { setConnectFnForTests(null); rmSync(home, { recursive: true, force: true }); });

describe("POST /api/workflow/analyze", () => {
  it("returns a recommendation and a project-namespaced pre-checked selection", async () => {
    const ctl = new GemController();
    const res = await ctl.workflowAnalyze({ body: { dir: join(home, ".claude"), root: projectRoot } });
    expect(res.degraded).toBe(false);
    expect(res.recommendation.include.map((i) => i.name)).toContain("qa");
    expect((res.selection as any).projects[projectRoot].skills).toContain("qa");
    expect(res.signalSummary.sessionsScanned).toBe(1);
  });
});
