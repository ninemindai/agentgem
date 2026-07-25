// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The rpg theme must be a pure presentation function emitting self-contained
// HTML: zero external URLs, payload baked as a JSON island, every interpolated
// string escaped, and an honest doorway (never a score) on insufficient data.
import { describe, expect, it } from "vitest";
import { COHORT } from "../gemit/cohort.js";
import type { GemitData } from "../gemit/score.js";
import { TIER_NAMES, perksFor, questsFor, renderRpgTheme } from "../gemit/themeRpg.js";

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
    skillVariety: 12, subagentVariety: 8, skillSessionsPct: 62, subagentSessionsPct: 41,
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
    expect(html).toContain("Top tier"); // the card's hook pill is Title Case, uppercased via CSS
    expect(html).toContain("Master Lapidary");
  });
});

describe("questsFor", () => {
  it("turns locked perks into quests with meters, exact deltas for setup perks", () => {
    const d = data({ subagentVariety: 3, skillVariety: 12, verifyRatePct: 24 });
    const quests = questsFor(d);
    const clones = quests.find((q) => q.id === "perk-shadow-clones")!;
    expect(clones.axis).toBe("setup");
    expect(clones.exact).toBe(true);
    expect(clones.delta).toBeGreaterThanOrEqual(1);
    expect(clones.meter).toEqual({ now: 3, target: 5, label: "3/5 subagent types" });
    const look = quests.find((q) => q.id === "perk-second-look")!;
    expect(look.axis).toBe("proc");
    expect(look.exact).toBe(false);
  });

  it("maps finding quests to axes with a proc fallback and caps at 3", () => {
    const quests = questsFor(data());
    const findingQs = quests.filter((q) => q.id.startsWith("finding-"));
    expect(findingQs).toHaveLength(3);
    expect(findingQs.find((q) => q.id === "finding-no-verify-finish")!.axis).toBe("proc");
    expect(findingQs.every((q) => !q.exact)).toBe(true);
  });

  it("falls back to assumed setup deltas when the share fields are absent (old cards)", () => {
    const legacy = { ...data({ subagentVariety: 3 }) } as Record<string, unknown>;
    delete legacy.skillSessionsPct; delete legacy.subagentSessionsPct;
    const clones = questsFor(legacy as never).find((q) => q.id === "perk-shadow-clones")!;
    expect(clones.exact).toBe(false);
  });
});

describe("interactive layer", () => {
  it("renders training grounds sliders, quest log, and the sim script", () => {
    const html = renderRpgTheme(data());
    expect((html.match(/role="slider"/g) ?? []).length).toBe(3);
    expect(html).toContain('id="training"');
    expect(html).toContain("Quest Log");
    expect(html).toContain("data-delta=");
    expect(html).toContain('id="confetti"');
    expect(html).toContain("function autoSolvePath");
    expect(html).toContain("GEMIT_CONST");
    expect(html).toContain("prefers-reduced-motion");
  });

  it("keeps the doorway static: no script, no training grounds", () => {
    const html = renderRpgTheme(data({ insufficient: true, qualifyingSessions: 2, composite: 0, tierLevel: 1 }));
    expect(html).not.toContain("GEMIT_CONST");
    expect(html).not.toContain('id="training"');
    expect(html).not.toContain("Quest Log");
  });

  it("counts the rank up from a span that still carries the near-miss line", () => {
    const html = renderRpgTheme(data());
    expect(html).toContain('data-n="79"');
    expect(html).toContain("1 pt from Master Lapidary");
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

describe("the card", () => {
  it("renders tier, ring, hook and pips as one screenshot-shaped block", () => {
    const html = renderRpgTheme(data());
    expect(html).toContain('class="card"');
    expect(html).toContain("Lapidary");
    expect(html).toContain('data-n="79"');                  // ring count-up target
    expect(html).toContain("1 pt from Master Lapidary");     // the hook
    // Precise to the pip divs themselves ("pip" or "pip low") — a bare /class="pip/ also
    // matches the wrapping `class="pips"` container and over-counts to 4.
    expect((html.match(/class="pip(?: low)?"/g) ?? []).length).toBe(3);
    expect(html).toContain("119-session streak");
    expect(html).toContain("4/5 techniques");
  });

  it("omits the cohort band entirely while COHORT is null", () => {
    expect(COHORT).toBeNull();                               // guards the premise
    const html = renderRpgTheme(data());
    expect(html).not.toContain("shared cards");
    expect(html).not.toContain("class=\"cohort\"");
    expect(html).not.toMatch(/top \d+%/i);
  });

  it("declares a solid tier colour before the gradient so it can never render invisible", () => {
    const html = renderRpgTheme(data());
    const tier = html.slice(html.indexOf(".tier{"), html.indexOf(".tier{") + 260);
    expect(tier.indexOf("color:#")).toBeLessThan(tier.indexOf("background-image:"));
    expect(tier).not.toMatch(/background:\s*linear-gradient/); // never the shorthand
  });

  it("shows no card at all on the doorway", () => {
    const html = renderRpgTheme(data({ insufficient: true, qualifyingSessions: 2, composite: 0, tierLevel: 1 }));
    expect(html).not.toContain('class="card"');
    expect(html).toContain("No score yet");
  });

  it("scales the tier headline down for long unbreakable words instead of clipping", () => {
    const cutter = renderRpgTheme(data({ tierLevel: 2, composite: 55 }));         // "Cutter", 6 chars
    const lapidary = renderRpgTheme(data());                                     // "Lapidary", 8 chars
    const prospector = renderRpgTheme(data({ tierLevel: 1, composite: 23 }));     // "Prospector", 10 chars
    const masterLapidary = renderRpgTheme(data({ tierLevel: 4, composite: 92 })); // "Master Lapidary"
    const tierMaxOf = (html: string): number => {
      const m = html.match(/<h1 class="tier" style="--tier-max:(\d+)px">/);
      if (!m) throw new Error("no --tier-max found on the tier heading");
      return Number(m[1]);
    };
    // A single unbreakable 10-char word (Prospector) must shrink well below a short one
    // (Cutter) — this is what keeps it from overflowing the crown-txt column.
    expect(tierMaxOf(prospector)).toBeLessThan(tierMaxOf(cutter));
    // Master Lapidary wraps at the space, so it's sized by its longest word ("Lapidary",
    // 8 chars) — the same bucket as Lapidary alone, not shrunk further by the full 15-char
    // string.
    expect(tierMaxOf(masterLapidary)).toBe(tierMaxOf(lapidary));
    // The CSS itself must read a per-render custom property for the clamp's max, not the old
    // bare hardcoded "8vw,60px)" (a fallback of "var(--tier-max,60px)" is fine — it's never
    // reached because renderCard always sets --tier-max inline).
    const tierRule = cutter.slice(cutter.indexOf(".tier{"), cutter.indexOf(".tier{") + 260);
    expect(tierRule).not.toContain("8vw,60px)");
    expect(tierRule).toContain("var(--tier-max");
  });

  it("keeps the ring's headline number in the card's ink colour, not the low-score accent", () => {
    const html = renderRpgTheme(data());
    const start = html.indexOf(".ring .num b{");
    const rule = html.slice(start, html.indexOf("}", start) + 1);
    // Higher-specificity override on the ring's own number rule — the base .count rule (kept
    // for the runtime's count-up hook) must not be left to paint this element on its own.
    expect(rule).toMatch(/color:\s*inherit/);
    expect(html).toContain('class="mono count"');
  });

  it("keeps the card's eyebrow left-aligned in the card's own ink, not centered in the doorway's muted grey", () => {
    const html = renderRpgTheme(data());
    const start = html.indexOf(".card .eyebrow{");
    const rule = html.slice(start, html.indexOf("}", start) + 1);
    expect(rule).toMatch(/text-align:\s*left/);
    expect(rule).toMatch(/color:\s*inherit/);
  });
});
