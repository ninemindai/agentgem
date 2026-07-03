// src/__tests__/learnCore.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnFromSession } from "../learnCore.js";
import { readQueue } from "../dream/store.js";
import type { DistilledSkill } from "@agentgem/insight";

const PROJ = "/Users/me/work/app";
let home: string;      // claude-home parent fixture
let claudeDir: string;
let base: string;      // queue store home

// Two sessions for PROJ; s-old older than s-new by mtime.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "learn-"));
  claudeDir = join(home, ".claude");
  const enc = join(claudeDir, "projects", "enc-a");
  mkdirSync(enc, { recursive: true });
  for (const f of ["s-old.jsonl", "s-new.jsonl"]) {
    writeFileSync(join(enc, f), JSON.stringify({ type: "summary" }) + "\n" + JSON.stringify({ cwd: PROJ }) + "\n");
  }
  utimesSync(join(enc, "s-old.jsonl"), new Date(1000), new Date(1000));
  utimesSync(join(enc, "s-new.jsonl"), new Date(2000), new Date(2000));
  base = mkdtempSync(join(tmpdir(), "learn-base-"));
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

const prov = { occurrences: [{ sessionId: "s1", transcript: "t.jsonl", messageIndices: [1], atMs: 5 }] };
const fakeSkill = {
  name: "extract-api-client", description: "d", confidence: "high",
  evidence: { sessions: 1, exampleSequence: [], root: PROJ, provenance: prov },
} as unknown as DistilledSkill;
const distillOne = async () => ({ distilled: [fakeSkill], degraded: false });

describe("learnFromSession", () => {
  it("distills the newest session by default and enqueues LEARN entries", async () => {
    const r = await learnFromSession({ root: PROJ, dir: claudeDir, base, distillWf: distillOne, extractRefl: () => [] });
    expect(r.session).toBe("s-new.jsonl");
    expect(r).toMatchObject({ enqueued: 1, skills: 1, lessons: 0, degraded: false });
    expect(r.entries).toEqual([{ kind: "skill", name: "extract-api-client" }]);
    const q = readQueue(base);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ kind: "skill", phase: "LEARN", name: "extract-api-client", status: "queued" });
  });

  it("targets a named session, with or without .jsonl", async () => {
    for (const ref of ["s-old", "s-old.jsonl"]) {
      const r = await learnFromSession({ root: PROJ, dir: claudeDir, base, session: ref, distillWf: distillOne, extractRefl: () => [] });
      expect(r.session).toBe("s-old.jsonl");
    }
  });

  it("rejects an unknown session ref with InvalidInputError (never treats it as a path)", async () => {
    await expect(learnFromSession({ root: PROJ, dir: claudeDir, base, session: "../../etc/passwd" }))
      .rejects.toThrow(/no session/i);
  });

  it("rejects a project with no sessions", async () => {
    await expect(learnFromSession({ root: "/Users/me/other", dir: claudeDir, base }))
      .rejects.toThrow(/no sessions/i);
  });

  it("re-learning the same evidence enqueues 0 (queue dedup)", async () => {
    await learnFromSession({ root: PROJ, dir: claudeDir, base, distillWf: distillOne, extractRefl: () => [] });
    const r2 = await learnFromSession({ root: PROJ, dir: claudeDir, base, distillWf: distillOne, extractRefl: () => [] });
    expect(r2).toMatchObject({ enqueued: 0, skills: 1 });
    expect(r2.entries).toEqual([]);
    expect(readQueue(base)).toHaveLength(1);
  });

  it("nothing distilled is a success, not an error", async () => {
    const r = await learnFromSession({
      root: PROJ, dir: claudeDir, base,
      distillWf: async () => ({ distilled: [], degraded: true }),
      extractRefl: () => [],
    });
    expect(r).toMatchObject({ enqueued: 0, skills: 0, lessons: 0, degraded: true });
  });
});
