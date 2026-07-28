// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Share packaging tests: the privacy strip (no skill/subagent names ship), the
// gem-archive round-trip with a signed digest, and the share/X URLs.
import { describe, expect, it, vi } from "vitest";
import { buildGemitShare, gemitShareUrls, GEMIT_SHARE_VERSION, shareVariantOf, standingClause } from "../gemit/share.js";
import { computeGemitData, type GemitData, type GemitScoredInput, type GemitSessionInput } from "../gemit/score.js";
import { MIN_COHORT, type Cohort } from "../gemit/cohort.js";
import { importGem } from "@agentgem/distribute";

// Deterministic GemitData fixture (composite 79 -> tier 3 "Lapidary"), inlined from
// gemitTheme.test.ts's data() so the percentile-direction assertions below have a
// known composite/tier to check against, independent of the computeGemitData() fixture
// above (which the rest of this file's tests already depend on for other shapes).
function fixtureData(over: Partial<GemitData> = {}): GemitData {
  return {
    windowFrom: "2026-06-18", windowTo: "2026-07-18",
    qualifyingSessions: 6405, scoredSessions: 119, projects: 44,
    totalMsgs: 476112, tokensOut: 248446123,
    ctx: 99, proc: 81, setup: 33, composite: 79, tierLevel: 3,
    verdicts: { bounded: 119, mixed: 0, bloated: 0 },
    labels: { disciplined: 43, loose: 7, chaotic: 5 },
    verifyRatePct: 24, boundedStreak: 119,
    firedFindings: [
      { id: "repeated-tool-error", title: "Repeated tool errors", sessions: 17 },
      { id: "no-verify-finish", title: "Unverified finish", sessions: 11 },
      { id: "retry-storm", title: "Retry storm", sessions: 9 },
      { id: "reread-churn", title: "Re-read churn", sessions: 3 },
    ],
    skillVariety: 12, subagentVariety: 8, skillSessionsPct: 62, subagentSessionsPct: 41,
    topSkills: ["brainstorming"], topSubagents: ["Explore"],
    agents: [{ name: "claude", sessions: 90 }, { name: "cursor", sessions: 29 }],
    insufficient: false,
    ...over,
  };
}

// Identity-mapped percentile table: cohort member at composite i sits at percentile i.
const cohortTable = (n = 500): Cohort => ({
  asOf: "2026-07-01",
  n,
  p: Array.from({ length: 101 }, (_, i) => i),
});

const NOW = Date.UTC(2026, 6, 19, 12);

function session(i: number): GemitSessionInput {
  return {
    sessionId: `s${i}`, agent: "claude", endMs: NOW - i * 3600_000, msgs: 20, tokensOut: 5000,
    skillNames: ["secret-skill", "other-skill"], subagentNames: ["secret-agent"],
    projectKey: `p${i % 2}`,
  };
}

function scored(i: number): GemitScoredInput {
  return {
    session: session(i), hygieneScore: 90, hygieneVerdict: "bounded",
    processScore: 80, processLabel: "disciplined",
    findings: [{ id: "f1", title: "Finding", count: 1 }], verifications: 1,
  };
}

const data = computeGemitData([0, 1, 2, 3, 4, 5].map(session), [0, 1, 2].map(scored), NOW);

describe("shareVariantOf", () => {
  it("strips skill/subagent names but keeps variety counts and scores", () => {
    const v = shareVariantOf(data);
    expect(v.topSkills).toEqual([]);
    expect(v.topSubagents).toEqual([]);
    expect(v.skillVariety).toBe(data.skillVariety);
    expect(v.subagentVariety).toBe(data.subagentVariety);
    expect(v.composite).toBe(data.composite);
    // source object untouched
    expect(data.topSkills.length).toBeGreaterThan(0);
  });
});

describe("buildGemitShare", () => {
  const built = buildGemitShare({ data, login: "tester" });

  it("keys the gem by login and window end date, version fixed", () => {
    expect(built.gemKey).toBe(`tester/gemit-${data.windowTo}`);
    expect(built.version).toBe(GEMIT_SHARE_VERSION);
    expect(built.manifest.gemKey).toBe(built.gemKey);
    expect(built.manifest.version).toBe(GEMIT_SHARE_VERSION);
  });

  it("publishes unlisted, tagged gemit, with a game artifact preview", () => {
    expect(built.manifest.visibility).toBe("unlisted");
    expect(built.manifest.tags).toContain("gemit");
    expect(built.manifest.artifactKinds).toEqual(["game"]);
    expect(built.manifest.artifacts).toEqual([{ name: `gemit-${data.windowTo}`, type: "game" }]);
    expect(built.manifest.description).toContain(String(data.composite));
    expect(built.manifest.description).toContain(`${data.scoredSessions} of ${data.qualifyingSessions}`);
  });

  it("round-trips as a valid gem archive whose digest is in the signed manifest", () => {
    const bytes = Buffer.from(built.archiveBase64, "base64");
    const { gem, meta } = importGem(bytes); // throws on bad lock
    expect(built.manifest.gemDigest).toBe(meta.gemDigest);
    expect(gem.artifacts).toHaveLength(1);
    const a = gem.artifacts[0] as { type: string; html: string; genre: string; engineVersion: string };
    expect(a.type).toBe("game");
    expect(a.genre).toBe("session-heatmap");
    expect(a.html).toBe(built.html);
  });

  it("ships NO skill or subagent names anywhere in the html", () => {
    expect(built.html).not.toContain("secret-skill");
    expect(built.html).not.toContain("secret-agent");
    // the JSON island carries the stripped variant
    expect(built.html).toContain('"topSkills":[]');
    expect(built.html).toContain('"topSubagents":[]');
  });

  // Agent names are a fixed public vocabulary, not personal data — but the consent line
  // the CLI prints promises "scores, counts, window dates" and nothing more. Until an
  // opt-in widens that promise explicitly, agents stay out of the shipped card too.
  it("ships no coding-agent names either, and no empty usage heading", () => {
    expect(built.html).toContain('"agents":[]');
    expect(built.html).not.toContain("What You Reach For");
    expect(built.html).not.toContain("Coding agents");
  });
});

describe("gemitShareUrls", () => {
  it("builds the marketplace game URL and an X intent URL that embeds it", () => {
    const { shareUrl, x } = gemitShareUrls("tester/gemit-2026-07-19", data);
    expect(shareUrl).toBe("https://app.agentgem.ai/games/tester/gemit-2026-07-19");
    expect(x.startsWith("https://x.com/intent/post?text=")).toBe(true);
    expect(decodeURIComponent(x)).toContain(shareUrl);
    expect(decodeURIComponent(x)).toContain(`${data.composite}/100`);
  });

  // LinkedIn's share-offsite and Facebook's sharer both take a URL and nothing else —
  // they render from the /games OG card and drop any text parameter. So the assertion
  // here is deliberately narrow: the card URL must survive encoding intact. It is the
  // ONLY thing those two networks carry.
  it("passes the card URL url-encoded to LinkedIn and Facebook", () => {
    const { shareUrl, linkedin, facebook } = gemitShareUrls("tester/gemit-2026-07-19", data);
    expect(linkedin).toBe(
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`);
    expect(facebook).toBe(
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`);
    // the slash in "tester/gemit-..." must be escaped, or the receiving parser truncates
    expect(linkedin).toContain("tester%2Fgemit-2026-07-19");
    expect(facebook).toContain("tester%2Fgemit-2026-07-19");
  });
});

describe("standingClause", () => {
  it("returns empty string when the cohort is absent or below MIN_COHORT", () => {
    expect(standingClause(79, null)).toBe("");
    expect(standingClause(79, undefined)).toBe("");
    expect(standingClause(79, cohortTable(MIN_COHORT - 1))).toBe("");
  });

  it("reads the correct direction: beating 79% of the cohort is 'top 21%', never 'top 79%'", () => {
    // identity table => percentileFor(composite, ...) === composite (that share of the cohort scored below it)
    expect(standingClause(79, cohortTable())).toBe(", top 21%");
    expect(standingClause(79, cohortTable())).not.toBe(", top 79%");
    // a strong scorer (beats 95%) must read a small top-N%, not a large one
    expect(standingClause(95, cohortTable())).toBe(", top 5%");
  });
});

describe("share text percentile", () => {
  it("omits any percentile claim while the cohort is absent (real COHORT stays null)", () => {
    const { x } = gemitShareUrls("me/gemit-2026-07-25", fixtureData());
    const text = decodeURIComponent(new URL(x).searchParams.get("text")!);
    expect(text).toContain("Lapidary");
    expect(text).toContain("79/100");
    expect(text).not.toMatch(/top \d+%/i);
  });
});

describe("card/share standing parity", () => {
  // Both the card (themeRpg.ts renderCard) and the share clause (standingClause,
  // above) must compute "top N%" from the exact same source (cohort.ts's
  // topPercentFor), not two independent `100 - pct` expressions that could drift.
  // COHORT is mocked here — not the real, always-null export — so this is the one
  // test in the suite that actually exercises the cohort-PRESENT rendering path
  // for the card; module mocking is required because renderCard reads the
  // module-level COHORT constant rather than taking one as a parameter.
  it("renders the identical top-N% number in the card and in the share clause for the same (composite, cohort)", async () => {
    const table = cohortTable();
    vi.resetModules();
    vi.doMock("../gemit/cohort.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../gemit/cohort.js")>();
      return { ...actual, COHORT: table };
    });
    try {
      const { renderRpgTheme } = await import("../gemit/themeRpg.js");
      const { standingClause: mockedStandingClause } = await import("../gemit/share.js");
      const { topPercentFor } = await import("../gemit/cohort.js");

      const d = fixtureData(); // composite 79, identity table -> beats 79% -> top 21%
      const shared = topPercentFor(d.composite, table);
      expect(shared).toBe(21); // sanity: matches the earlier direction test

      const html = renderRpgTheme(d);
      const cardMatch = html.match(/Top <b>(\d+)%<\/b>/);
      expect(cardMatch).not.toBeNull();
      expect(Number(cardMatch![1])).toBe(shared);

      expect(mockedStandingClause(d.composite, table)).toBe(`, top ${shared}%`);
    } finally {
      vi.doUnmock("../gemit/cohort.js");
      vi.resetModules();
    }
  });
});
