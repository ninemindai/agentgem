import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GemController } from "../../gem.controller.js";
import { computeGlobalUsage } from "@agentgem/capture";
import { readGlobalUsageCacheStale, writeGlobalUsageCache } from "@agentgem/capture";
import { allClaudeTranscripts } from "@agentgem/insight";
import { resolveDirs } from "@agentgem/model";

let home: string, claudeDir: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "guse-"));
  claudeDir = join(home, ".claude");
  const gskill = join(claudeDir, "skills", "diagram");
  mkdirSync(gskill, { recursive: true });
  writeFileSync(join(gskill, "SKILL.md"), "---\nname: diagram\ndescription: d\n---\nbody");
  const tu = (s: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: s } }] } });
  const a = join(claudeDir, "projects", "encA"); mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "a.jsonl"), [JSON.stringify({ cwd: "/projA" }), tu("diagram"), tu("diagram")].join("\n") + "\n");
  const b = join(claudeDir, "projects", "encB"); mkdirSync(b, { recursive: true });
  writeFileSync(join(b, "b.jsonl"), [JSON.stringify({ cwd: "/projB" }), tu("diagram")].join("\n") + "\n");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("computeGlobalUsage", () => {
  it("aggregates a global skill across all transcripts, globals only", () => {
    const dirs = resolveDirs(claudeDir);
    const res = computeGlobalUsage(dirs, allClaudeTranscripts(dirs.claudeDir));
    const d = res.artifacts.find((a) => a.name === "diagram");
    expect(d).toBeTruthy();
    expect(d!.invocations).toBe(3);   // 2 (A) + 1 (B)
    expect(d!.root).toBeNull();
  });
});

describe("stale-while-revalidate", () => {
  let h2: string, prev: string | undefined;
  beforeEach(() => { h2 = mkdtempSync(join(tmpdir(), "swr-")); prev = process.env.AGENTGEM_HOME; process.env.AGENTGEM_HOME = h2; });
  afterEach(() => { if (prev === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = prev; rmSync(h2, { recursive: true, force: true }); });

  it("readGlobalUsageCacheStale returns the stored result regardless of token", () => {
    const r = { artifacts: [{ type: "skill", name: "x", root: null, invocations: 9, sessionsUsedIn: 1, lastUsedMs: 1 }] };
    writeGlobalUsageCache("token-A", r);
    expect(readGlobalUsageCacheStale()).toEqual(r);   // even though we never pass token-A
  });
  it("readGlobalUsageCacheStale returns null when no cache exists", () => {
    expect(readGlobalUsageCacheStale()).toBeNull();
  });
  it("endpoint serves a stale cache synchronously when the live token differs", async () => {
    // prime a stale entry under a bogus token; the real scan of `claudeDir` yields a different token
    const stale = { artifacts: [{ type: "skill", name: "STALE", root: null, invocations: 42, sessionsUsedIn: 1, lastUsedMs: 1 }] };
    const dirs = resolveDirs(claudeDir);
    writeGlobalUsageCache("bogus-token", stale, dirs.claudeDir);
    const res = await new GemController().usage({ query: { dir: claudeDir, scope: "global" } });
    expect(res.artifacts).toEqual(stale.artifacts);   // served the stale result, not a fresh scan
  });
});
