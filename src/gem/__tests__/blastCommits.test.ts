// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/blastCommits.test.ts
//
// attachCommitFiles / addCandidateCommits: joining a blast report's observed
// commit SHAs to the files git says those commits touched, and window-matching
// git log for commits the transcript did not confirm — evidence-bounded, a
// commit git can no longer resolve keeps `files` absent rather than guessing,
// and window matches are marked candidate, never presented as observed.
import { describe, it, expect } from "vitest";
import { attachCommitFiles, addCandidateCommits } from "@agentgem/app/sessionBlastCore";
import type { BlastReport, BlastEvent } from "@agentgem/insight";

const report = (shas: string[]): BlastReport => ({
  meta: { sessionId: "s", transcript: "t.jsonl", project: "~/proj", startMs: 0, endMs: 1 },
  events: [],
  commits: shas.map((sha, i) => ({ sha, seq: i, tsMs: null })),
});

describe("attachCommitFiles", () => {
  it("attaches cwd-relative files per commit and never invokes git without commits", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse") return "\n";
      if (args.includes("abc1234")) return "src/a.ts\ndocs/b.md\n";
      return "src/c.ts\n";
    };
    const rep = await attachCommitFiles(report(["abc1234", "beef456"]), "/w/proj", run);
    expect(rep.commits).toEqual([
      { sha: "abc1234", seq: 0, tsMs: null, files: ["src/a.ts", "docs/b.md"] },
      { sha: "beef456", seq: 1, tsMs: null, files: ["src/c.ts"] },
    ]);

    calls.length = 0;
    await attachCommitFiles(report([]), "/w/proj", run);
    expect(calls).toEqual([]);
  });

  it("strips the repo prefix when the session cwd is a subdirectory", async () => {
    const run = async (args: string[]) =>
      args[0] === "rev-parse" ? "packages/insight/\n" : "packages/insight/src/x.ts\nREADME.md\n";
    const rep = await attachCommitFiles(report(["abc1234"]), "/w/proj/packages/insight", run);
    // files outside the cwd prefix keep their repo-relative path (they just won't match a cell)
    expect(rep.commits[0].files).toEqual(["src/x.ts", "README.md"]);
  });

  it("leaves files absent for a commit git cannot resolve, and for all commits when rev-parse fails", async () => {
    const run = async (args: string[]) => {
      if (args[0] === "rev-parse") return "\n";
      if (args.includes("gone999")) throw new Error("bad object");
      return "src/a.ts\n";
    };
    const rep = await attachCommitFiles(report(["abc1234", "gone999"]), "/w/proj", run);
    expect(rep.commits[0].files).toEqual(["src/a.ts"]);
    expect(rep.commits[1].files).toBeUndefined();

    const dead = async () => { throw new Error("not a git repo"); };
    const rep2 = await attachCommitFiles(report(["abc1234"]), "/w/proj", dead);
    expect(rep2.commits[0].files).toBeUndefined();
  });
});

// A session window of 10:00–10:10 UTC; the margin is two minutes either side.
const START = Date.parse("2026-08-18T10:00:00Z");
const END = Date.parse("2026-08-18T10:10:00Z");
const FULL_A = "a".repeat(40);
const FULL_B = "b".repeat(40);
const commitEv: BlastEvent = { seq: 0, msgIndex: 0, tsMs: START, tool: "Bash", action: "exec", target: "git commit" };

const winReport = (events: BlastEvent[], commits: BlastReport["commits"]): BlastReport => ({
  meta: { sessionId: "s", transcript: "t.jsonl", project: "~/proj", startMs: START, endMs: END },
  events,
  commits,
});

describe("addCandidateCommits", () => {
  it("never consults git for a session that ran no git commit", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); return ""; };
    const rep = await addCandidateCommits(winReport([{ ...commitEv, target: "git log" }], []), "/w/proj", run);
    expect(calls).toEqual([]);
    expect(rep.commits).toEqual([]);
  });

  it("window-matches git log (log only — files are attachCommitFiles' job) and marks matches candidate", async () => {
    const inWin = Math.floor((START + 60_000) / 1000);
    const early = Math.floor((START - 300_000) / 1000);     // outside even the margin
    const run = async (args: string[]) => {
      if (args[0] === "log") return `${FULL_A} ${inWin}\n${FULL_B} ${early}\n`;
      throw new Error(`unexpected ${args[0]}`);
    };
    const rep = await addCandidateCommits(winReport([commitEv], []), "/w/proj", run);
    expect(rep.commits).toEqual([
      { sha: FULL_A, seq: null, tsMs: inWin * 1000, candidate: true },
    ]);
  });

  it("excludes window commits already observed (short-sha prefix match) and keeps observed first", async () => {
    const inWin = Math.floor((START + 60_000) / 1000);
    const observed = { sha: FULL_A.slice(0, 7), seq: 0, tsMs: START };
    const run = async (args: string[]) => {
      if (args[0] === "log") return `${FULL_A} ${inWin}\n${FULL_B} ${inWin}\n`;
      throw new Error(`unexpected ${args[0]}`);
    };
    const rep = await addCandidateCommits(winReport([commitEv], [observed]), "/w/proj", run);
    expect(rep.commits).toEqual([
      observed,
      { sha: FULL_B, seq: null, tsMs: inWin * 1000, candidate: true },
    ]);
  });

  it("returns the report unchanged when git log fails", async () => {
    const dead = async () => { throw new Error("not a repo"); };
    const rep = await addCandidateCommits(winReport([commitEv], []), "/w/proj", dead);
    expect(rep.commits).toEqual([]);
  });

  it("skips a zero-length window (no timestamps) rather than querying all of history", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); return ""; };
    const rep: BlastReport = { meta: { sessionId: "s", transcript: "t", project: null, startMs: 0, endMs: 0 }, events: [commitEv], commits: [] };
    await addCandidateCommits(rep, "/w/proj", run);
    expect(calls).toEqual([]);
  });
});

describe("attachCommitFiles on candidates", () => {
  it("resolves a 40-char candidate sha and preserves its candidate flag", async () => {
    const rep: BlastReport = {
      meta: { sessionId: "s", transcript: "t.jsonl", project: "~/proj", startMs: 0, endMs: 1 },
      events: [],
      commits: [{ sha: FULL_A, seq: null, tsMs: 5, candidate: true }],
    };
    const run = async (args: string[]) => (args[0] === "rev-parse" ? "\n" : "src/x.ts\n");
    const out = await attachCommitFiles(rep, "/w/proj", run);
    expect(out.commits).toEqual([{ sha: FULL_A, seq: null, tsMs: 5, candidate: true, files: ["src/x.ts"] }]);
  });
});
