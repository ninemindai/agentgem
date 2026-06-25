// src/gem/__tests__/runGem.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeGemToTestbed, materializeAndRunGem } from "../runGem.js";
import type { RunConnectFn, RunResult } from "../acpRun.js";
import type { Gem } from "../types.js";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "rungem-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const gem: Gem = {
  name: "qa-gem",
  createdFrom: "test",
  artifacts: [
    { type: "skill", name: "qa", source: "project", content: "# QA skill\nRun the tests." },
    { type: "instructions", name: "CLAUDE.md", content: "Always QA before shipping." },
  ],
  checks: [],
  requiredSecrets: [],
};

// A fake agent that records the cwd it was opened in and replays a canned result.
function fakeAgent(result: RunResult) {
  const calls = { cwd: null as string | null };
  const connectFn: RunConnectFn = async () => ({
    ctx: {
      async open(cwd: string) {
        calls.cwd = cwd;
        return {
          async setMode() {},
          async prompt() { return result; },
          dispose() {},
        };
      },
    },
    close() {},
  });
  return { connectFn, calls };
}

describe("materializeGemToTestbed", () => {
  it("writes the gem's skill into the runnable .claude/skills layout", () => {
    const dir = tmp();
    const res = materializeGemToTestbed(gem, dir);
    const skillPath = join(dir, ".claude", "skills", "qa", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, "utf8")).toContain("Run the tests.");
    expect(res.written.some((w) => w.type === "skill" && w.name === "qa")).toBe(true);
  });

  it("folds the gem's instructions into CLAUDE.md", () => {
    const dir = tmp();
    materializeGemToTestbed(gem, dir);
    const claudeMd = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("Always QA before shipping.");
  });
});

describe("materializeAndRunGem", () => {
  it("materializes into dir, then runs the agent in that same dir", async () => {
    const dir = tmp();
    const { connectFn, calls } = fakeAgent({ text: "done", toolCalls: [{ toolCallId: "t1", title: "Skill(qa)", status: "completed" }] });
    const out = await materializeAndRunGem({ gem, dir, task: "run qa", connectFn });
    expect(existsSync(join(dir, ".claude", "skills", "qa", "SKILL.md"))).toBe(true); // materialized
    expect(calls.cwd).toBe(dir);                                                     // ran in that dir
    expect(out.run.ok).toBe(true);
    expect(out.run.result.toolCalls[0].title).toBe("Skill(qa)");
  });

  it("attaches a verification report when expectations are supplied", async () => {
    const dir = tmp();
    const { connectFn } = fakeAgent({ text: "qa complete", toolCalls: [{ toolCallId: "t1", title: "Skill(qa)", status: "completed" }] });
    const out = await materializeAndRunGem({
      gem, dir, task: "run qa", connectFn,
      expectations: { expectTools: ["qa"], expectText: /complete/i },
    });
    expect(out.verification?.passed).toBe(true);
  });

  it("omits verification when no expectations are supplied", async () => {
    const dir = tmp();
    const { connectFn } = fakeAgent({ text: "done", toolCalls: [] });
    const out = await materializeAndRunGem({ gem, dir, task: "go", connectFn });
    expect(out.verification).toBeUndefined();
  });
});
