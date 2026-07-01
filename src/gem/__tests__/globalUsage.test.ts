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
  it("endpoint serves FRESH indexed usage, superseding any stale cache", async () => {
    // The persistent index is now the primary path: it returns fresh data fast, so
    // a stale cache is no longer served on the happy path (the old SWR stale-serving
    // is only a fallback for when the index errors). Prime a stale entry and confirm
    // the endpoint ignores it in favor of the real, indexed scan of `claudeDir`.
    const stale = { artifacts: [{ type: "skill", name: "STALE", root: null, invocations: 42, sessionsUsedIn: 1, lastUsedMs: 1 }] };
    const dirs = resolveDirs(claudeDir);
    writeGlobalUsageCache("bogus-token", stale, dirs.claudeDir);
    const res = await new GemController().usage({ query: { dir: claudeDir, scope: "global" } });
    const names = res.artifacts.map((a) => a.name);
    expect(names).toContain("diagram");        // fresh, from the index
    expect(names).not.toContain("STALE");       // the stale cache was NOT served
    const d = res.artifacts.find((a) => a.name === "diagram");
    expect(d!.invocations).toBe(3);             // 2 (A) + 1 (B), same as computeGlobalUsage
    expect(d!.root).toBeNull();
  });
});
