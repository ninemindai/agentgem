// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Share packaging tests: the privacy strip (no skill/subagent names ship), the
// gem-archive round-trip with a signed digest, and the share/X URLs.
import { describe, expect, it } from "vitest";
import { buildGemitShare, gemitShareUrls, GEMIT_SHARE_VERSION, shareVariantOf } from "../gemit/share.js";
import { computeGemitData, type GemitScoredInput, type GemitSessionInput } from "../gemit/score.js";
import { importGem } from "@agentgem/distribute";

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
});

describe("gemitShareUrls", () => {
  it("builds the marketplace game URL and an X intent URL that embeds it", () => {
    const { shareUrl, xIntentUrl } = gemitShareUrls("tester/gemit-2026-07-19", data);
    expect(shareUrl).toBe("https://app.agentgem.ai/games/tester/gemit-2026-07-19");
    expect(xIntentUrl.startsWith("https://x.com/intent/post?text=")).toBe(true);
    expect(decodeURIComponent(xIntentUrl)).toContain(shareUrl);
    expect(decodeURIComponent(xIntentUrl)).toContain(`${data.composite}/100`);
  });
});
