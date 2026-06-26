// src/gem/__tests__/runGem.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeGemToTestbed, materializeAndRunGem, AGENT_ADAPTERS, registerRun, resolveRun } from "../runGem.js";
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

// A fake agent that records the descriptor + cwd it was driven with, and replays a canned result.
function fakeAgent(result: RunResult) {
  const calls = { cwd: null as string | null, command: null as string | null };
  const connectFn: RunConnectFn = async (descriptor) => ({
    ctx: {
      async open(cwd: string) {
        calls.cwd = cwd;
        calls.command = descriptor.command.join(" ");
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

  it("defaults to the Claude adapter", async () => {
    const dir = tmp();
    const { connectFn, calls } = fakeAgent({ text: "", toolCalls: [] });
    const out = await materializeAndRunGem({ gem, dir, task: "go", connectFn });
    expect(calls.command).toContain("claude-agent-acp");
    expect(out.agent).toBe("claude");
  });

  it("selects the codex adapter and materializes to the codex flavor", async () => {
    const dir = tmp();
    const { connectFn, calls } = fakeAgent({ text: "", toolCalls: [] });
    await materializeAndRunGem({ gem, dir, task: "go", agent: "codex", connectFn });
    expect(calls.command).toBe("codex-agent-acp");
    // codex flavor writes skills under .agents/skills, not .claude/skills
    expect(existsSync(join(dir, ".agents", "skills", "qa", "SKILL.md"))).toBe(true);
  });
});

describe("run registry", () => {
  it("registers a runDir + agent under an opaque id and resolves it", () => {
    const id = registerRun("/tmp/some-run-dir", "claude");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(resolveRun(id)).toEqual({ dir: "/tmp/some-run-dir", agent: "claude" });
  });

  it("returns undefined for an unknown id (no path leaks through)", () => {
    expect(resolveRun("not-a-real-id")).toBeUndefined();
  });

  it("issues distinct ids for distinct runs", () => {
    const a = registerRun("/tmp/a", "claude");
    const b = registerRun("/tmp/b", "codex");
    expect(a).not.toBe(b);
    expect(resolveRun(b)).toEqual({ dir: "/tmp/b", agent: "codex" });
  });
});

describe("AGENT_ADAPTERS", () => {
  it("maps each agent id to a descriptor + testbed flavor; only claude is validated", () => {
    expect(AGENT_ADAPTERS.claude.flavor).toBe("claude");
    expect(AGENT_ADAPTERS.claude.descriptor.command).toContain("claude-agent-acp");
    expect(AGENT_ADAPTERS.claude.validated).toBe(true);
    expect(AGENT_ADAPTERS.codex.flavor).toBe("codex");
    expect(AGENT_ADAPTERS.codex.validated).toBe(false);
  });
});
