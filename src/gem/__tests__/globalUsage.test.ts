import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GemController } from "../../gem.controller.js";
import { computeGlobalUsage, closeSharedIndex, getGlobalUsageIndexed, getGlobalUsageStale, hookDigest } from "@agentgem/capture";
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

  it("closeSharedIndex closes the opened index; it is idempotent and a later usage call reopens", async () => {
    const first = await new GemController().usage({ query: { dir: claudeDir, scope: "global" } });
    expect(first.artifacts.map((a) => a.name)).toContain("diagram");   // opens the shared index
    await closeSharedIndex();                                          // graceful-shutdown close
    await closeSharedIndex();                                          // idempotent — safe to call twice
    const again = await new GemController().usage({ query: { dir: claudeDir, scope: "global" } });
    expect(again.artifacts.map((a) => a.name)).toContain("diagram");   // transparently reopened
  });
});

describe("getGlobalUsageIndexed — inventory-independent", () => {
  let h3: string, prev3: string | undefined;
  beforeEach(() => { h3 = mkdtempSync(join(tmpdir(), "guse-idx-")); prev3 = process.env.AGENTGEM_HOME; process.env.AGENTGEM_HOME = h3; });
  afterEach(async () => {
    await closeSharedIndex();
    if (prev3 === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = prev3;
    rmSync(h3, { recursive: true, force: true });
  });

  it("returns the same artifacts as computeGlobalUsage for the same corpus", async () => {
    const dirs = resolveDirs(claudeDir);
    const paths = allClaudeTranscripts(dirs.claudeDir);
    const want = computeGlobalUsage(dirs, paths).artifacts;
    const got = (await getGlobalUsageIndexed(dirs, paths)).artifacts;
    const key = (a: { type: string; name: string }) => `${a.type} ${a.name}`;
    const sort = <T extends { type: string; name: string }>(xs: T[]) => [...xs].sort((a, b) => key(a).localeCompare(key(b)));
    expect(sort(got)).toEqual(sort(want));
  });

  it("getGlobalUsageStale reports stale on a cold index, then fresh once the index is built", async () => {
    const dirs = resolveDirs(claudeDir);
    const paths = allClaudeTranscripts(dirs.claudeDir);
    // Cold: nothing indexed under this fresh AGENTGEM_HOME → stale, and no figures resolved yet.
    const cold = await getGlobalUsageStale(dirs, paths);
    expect(cold.stale).toBe(true);
    expect(cold.result.artifacts.find((a) => a.name === "diagram")).toBeUndefined();
    // Build the index (the same sync the background revalidate performs, awaited here for determinism).
    await getGlobalUsageIndexed(dirs, paths);
    // Warm: caught up → fresh, and the diagram skill (3 uses across the corpus) now resolves.
    const warm = await getGlobalUsageStale(dirs, paths);
    expect(warm.stale).toBe(false);
    expect(warm.result.artifacts.find((a) => a.name === "diagram")?.invocations).toBe(3);
  });
});

describe("hookDigest", () => {
  it("changes when a hook's config changes, not when a skill is added", () => {
    const h = (cmd: string) => [{ type: "hook" as const, name: "s", event: "Stop", config: { hooks: [{ command: cmd }] } }];
    expect(hookDigest(h("/a.sh"))).toBe(hookDigest(h("/a.sh")));
    expect(hookDigest(h("/a.sh"))).not.toBe(hookDigest(h("/b.sh")));
    // hookDigest's signature takes only hooks — a skill added to the inventory is not even
    // representable here, which IS the fix: skills cannot influence this digest.
  });

  it("is stable under hook reorder (T-I)", () => {
    const hA = { type: "hook" as const, name: "a", event: "Stop", config: { hooks: [{ command: "/a.sh" }] } };
    const hB = { type: "hook" as const, name: "b", event: "Stop", config: { hooks: [{ command: "/b.sh" }] } };
    expect(hookDigest([hA, hB])).toBe(hookDigest([hB, hA]));
  });
});
