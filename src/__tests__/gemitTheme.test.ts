// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The rpg theme must be a pure presentation function emitting self-contained
// HTML: zero external URLs, payload baked as a JSON island, every interpolated
// string escaped, and an honest doorway (never a score) on insufficient data.
import { describe, expect, it } from "vitest";
import type { GemitData } from "../gemit/score.js";
import { TIER_NAMES, perksFor, renderRpgTheme } from "../gemit/themeRpg.js";

function data(over: Partial<GemitData> = {}): GemitData {
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
    skillVariety: 12, subagentVariety: 8,
    topSkills: ["brainstorming"], topSubagents: ["Explore"],
    insufficient: false,
    ...over,
  };
}

describe("renderRpgTheme", () => {
  it("renders a self-contained document with the tier and a parseable data island", () => {
    const d = data();
    const html = renderRpgTheme(d);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Lapidary");           // tier 3 name
    expect(html).toContain("1 pt from Master Lapidary"); // near-miss hook (80-79)
    expect(html).not.toMatch(/https?:\/\//);      // zero external URLs
    const island = html.match(/<script type="application\/json" id="gemit-data">(.*?)<\/script>/s);
    expect(island).not.toBeNull();
    expect(JSON.parse(island![1])).toEqual(d);
    expect(html).toContain("119 most recent substantial sessions of");  // cap-and-disclose
  });

  it("escapes hostile strings from finding titles", () => {
    const html = renderRpgTheme(data({
      firedFindings: [{ id: "x", title: "<script>alert(1)</script>", sessions: 2 }],
    }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders the doorway (never a score) when insufficient", () => {
    const html = renderRpgTheme(data({
      insufficient: true, qualifyingSessions: 2, composite: 0, tierLevel: 1,
    }));
    expect(html).toContain("No score yet");
    for (const name of TIER_NAMES) expect(html).not.toContain(name);
    expect(html).not.toContain("RANK 0");
  });

  it("says top tier for a Master Lapidary", () => {
    const html = renderRpgTheme(data({ composite: 88, tierLevel: 4 }));
    expect(html).toContain("top tier");
    expect(html).toContain("Master Lapidary");
  });
});

describe("perksFor", () => {
  it("unlocks from thresholds and keeps the rest visibly sealed", () => {
    const { unlocked, locked } = perksFor(data());
    const names = unlocked.map((p) => p.name);
    expect(names).toContain("Shadow Step");     // 119/119 bounded
    expect(names).toContain("Shadow Clones");   // 8 subagent types
    expect(names).toContain("Scroll Mastery");  // 12 skills
    expect(names).toContain("Clean Cut");       // streak 119
    expect(locked.map((p) => p.name)).toContain("Second Look"); // 24% verify
    expect(unlocked.length + locked.length).toBe(5);
  });
});
