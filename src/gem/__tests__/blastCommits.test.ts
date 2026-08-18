// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/blastCommits.test.ts
//
// attachCommitFiles: joining a blast report's observed commit SHAs to the files
// git says those commits touched — evidence-bounded, a commit git can no longer
// resolve keeps `files` absent rather than guessing.
import { describe, it, expect } from "vitest";
import { attachCommitFiles } from "@agentgem/app/sessionBlastCore";
import type { BlastReport } from "@agentgem/insight";

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
