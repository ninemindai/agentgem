// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// `ScrubbedStep.verbDetail` — the finer verb for the one case the coarse verb hides: a script
// runner, where argv0 names the interpreter rather than the work.
//
// The invariant these tests protect is that the change is ADDITIVE: `verb` must be byte-identical
// to what it was, because ~8 consumers (extract, detectors, distill, sessionLessons,
// detectorRules, sessionSummary, blastScan, criterionJudge) key procedure recurrence off it.
import { describe, it, expect } from "vitest";
import { scrubStep } from "../scrub.js";

const bash = (command: string) => scrubStep("Bash", { command });

describe("verbDetail", () => {
  it("names the script when the coarse verb only names the interpreter", () => {
    const step = bash("python3 .claude/skills/ppt-master/scripts/finalize_svg.py --project deck");
    expect(step.verb).toBe("Bash:python3");        // unchanged: recurrence still collapses
    expect(step.verbDetail).toBe("Bash:finalize_svg.py"); // added: naming now possible
  });

  it("distinguishes two scripts the coarse verb makes identical", () => {
    // The actual defect: a four-step script pipeline reads as Bash:python3 x4.
    const a = bash("python3 scripts/total_md_split.py p");
    const b = bash("python3 scripts/svg_to_pptx.py p");
    expect(a.verb).toBe(b.verb);
    expect(a.verbDetail).not.toBe(b.verbDetail);
  });

  it("handles the other common runners", () => {
    expect(bash("node build/build-runner.mjs").verbDetail).toBe("Bash:build-runner.mjs");
    expect(bash("bash ./deploy.sh --prod").verbDetail).toBe("Bash:deploy.sh");
    expect(bash("npx tsx src/seed.ts").verbDetail).toBe("Bash:seed.ts");
  });

  it("keeps only the basename — a directory would re-add the location detail de-homing removes", () => {
    const step = bash("python3 /Users/someone/secret-client/etl.py");
    expect(step.verbDetail).toBe("Bash:etl.py");
    expect(step.verbDetail).not.toContain("/");
    expect(step.verbDetail).not.toContain("someone");
  });

  it("is absent when the verb already identifies the work", () => {
    // Adding it here would double the vocabulary for no gain.
    expect(bash("gh pr merge 12").verbDetail).toBeUndefined();
    expect(bash("git commit -m wip").verbDetail).toBeUndefined();
    expect(bash("pnpm build").verbDetail).toBeUndefined();
  });

  it("is absent when a runner is invoked with no script", () => {
    expect(bash("node --version").verbDetail).toBeUndefined();
    expect(bash("python3").verbDetail).toBeUndefined();
    expect(bash("").verbDetail).toBeUndefined();
  });

  it("does not fire on a bare filename that isn't a runner's argument", () => {
    expect(bash("cat notes.py").verbDetail).toBeUndefined();
  });

  it("leaves every non-Bash builtin untouched", () => {
    expect(scrubStep("Edit", { file_path: "/tmp/a.py" }).verbDetail).toBeUndefined();
    expect(scrubStep("Read", { file_path: "/tmp/a.py" }).verbDetail).toBeUndefined();
  });

  it("still scrubs a secret out of arg when verbDetail is populated", () => {
    // verbDetail must not become a bypass around the scrubber.
    const step = bash("python3 run.py --token ghp_0123456789abcdefghijklmnopqrstuvwxyz");
    expect(step.verbDetail).toBe("Bash:run.py");
    expect(step.arg).toContain("<redacted>");
    expect(step.arg).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz");
  });
});
