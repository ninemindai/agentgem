// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// GemitController: the two guards that stop a bad card from being published, and the
// opt-in threading through to the shipped archive. The scan itself is stubbed via the
// test seam — walking 30 days of transcripts to exercise a guard clause would be absurd.
import { afterEach, describe, expect, it } from "vitest";
import { GemitController, setGemitDepsForTests } from "../gemit.controller.js";
import { importGem } from "@agentgem/distribute";
import type { GemitData } from "../gemit/score.js";

afterEach(() => setGemitDepsForTests(null));

function data(over: Partial<GemitData> = {}): GemitData {
  return {
    windowFrom: "2026-06-18", windowTo: "2026-07-18",
    qualifyingSessions: 10, scoredSessions: 10, projects: 2,
    totalMsgs: 100, tokensOut: 1000,
    ctx: 90, proc: 80, setup: 40, composite: 76, tierLevel: 3,
    verdicts: { bounded: 9, mixed: 1, bloated: 0 },
    labels: { disciplined: 5, loose: 1, chaotic: 0 },
    verifyRatePct: 50, boundedStreak: 9, firedFindings: [],
    skillVariety: 3, subagentVariety: 2, skillSessionsPct: 50, subagentSessionsPct: 33,
    topSkills: ["secret-skill"], topSubagents: ["secret-agent"],
    agents: [{ name: "claude", sessions: 10 }],
    insufficient: false,
    ...over,
  };
}

const bound = () => ({ bound: true, login: "tester" });
const publishOk = async () => ({ shared: true as const, publishedBy: "tester" });

describe("GemitController.report", () => {
  it("summarises the window and reports whether publishing is even possible", async () => {
    setGemitDepsForTests({ score: async () => data(), binding: bound as never });
    const r = await new GemitController().report();
    expect(r.tier).toBe("Lapidary");
    expect(r.composite).toBe(76);
    expect(r.bound).toBe(true);
    expect(r.login).toBe("tester");
  });

  // The panel frames this in sandbox="allow-scripts", where no link can navigate — so the
  // html must arrive sealed, with the share affordances left to the panel's own React.
  // `sealed` suppresses the SHARE region only: this is the operator's own machine, so the
  // usage names still render. Nothing here is published.
  it("returns the report sealed — no share region or link, but usage still shown", async () => {
    setGemitDepsForTests({ score: async () => data(), binding: bound as never });
    const r = await new GemitController().report();
    expect(r.html).not.toMatch(/https?:\/\//);
    expect(r.html).not.toContain("gemit --share");
    expect(r.html).not.toContain('<section class="share-out">');
    expect(r.html).toContain("What You Reach For");
    expect(r.html).toContain("secret-skill");
  });

  it("reports unbound rather than pretending publishing will work", async () => {
    setGemitDepsForTests({ score: async () => data(), binding: (() => ({ bound: false })) as never });
    const r = await new GemitController().report();
    expect(r.bound).toBe(false);
    expect(r.login).toBeNull();
  });
});

describe("GemitController.publish", () => {
  it("refuses without a bound account, before scoring anything", async () => {
    let scored = false;
    setGemitDepsForTests({
      binding: (() => ({ bound: false })) as never,
      score: async () => { scored = true; return data(); },
    });
    const r = await new GemitController().publish({ body: { includeUsage: false } });
    expect(r).toMatchObject({ published: false, reason: "not-bound", shareUrl: null });
    expect(scored).toBe(false); // no point walking the disk to reject
  });

  it("refuses to publish a card with no score behind it", async () => {
    setGemitDepsForTests({ binding: bound as never, score: async () => data({ insufficient: true }) });
    const r = await new GemitController().publish({ body: { includeUsage: false } });
    expect(r).toMatchObject({ published: false, reason: "insufficient" });
  });

  it("surfaces the aggregator's rejection verbatim instead of a generic failure", async () => {
    setGemitDepsForTests({
      binding: bound as never, score: async () => data(),
      publish: async () => ({ shared: false as const, rejected: "conflict" }),
    });
    const r = await new GemitController().publish({ body: { includeUsage: false } });
    expect(r).toMatchObject({ published: false, reason: "conflict" });
  });

  it("publishes and returns all three intent URLs", async () => {
    setGemitDepsForTests({ binding: bound as never, score: async () => data(), publish: publishOk });
    const r = await new GemitController().publish({ body: { includeUsage: false } });
    expect(r.published).toBe(true);
    expect(r.shareUrl).toBe("https://app.agentgem.ai/games/tester/gemit-2026-07-18");
    expect(r.x).toContain("x.com/intent/post");
    expect(r.linkedin).toContain("linkedin.com/sharing/share-offsite");
    expect(r.facebook).toContain("facebook.com/sharer/sharer.php");
  });

  // The checkbox in the panel has to actually reach the archive, not just the copy above it.
  it("threads includeUsage through to what actually ships", async () => {
    // Decode the archive rather than grepping its bytes — a .gem is compressed, so a raw
    // substring search silently finds nothing and the assertion passes for the wrong reason.
    const sent: string[] = [];
    const capture = async (a: { archiveBase64: string }) => {
      const { gem } = importGem(Buffer.from(a.archiveBase64, "base64"));
      sent.push((gem.artifacts[0] as { html: string }).html);
      return { shared: true as const, publishedBy: "tester" };
    };
    setGemitDepsForTests({ binding: bound as never, score: async () => data(), publish: capture as never });
    await new GemitController().publish({ body: { includeUsage: false } });
    await new GemitController().publish({ body: { includeUsage: true } });

    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toContain("secret-skill");
    expect(sent[1]).toContain("secret-skill");
  });
});
