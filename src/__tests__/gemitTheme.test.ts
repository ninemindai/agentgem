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
    agents: [{ name: "claude", sessions: 90 }, { name: "cursor", sessions: 29 }],
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
  it("renders discipline sliders, quest log, and the sim script", () => {
    const html = renderRpgTheme(data());
    expect((html.match(/role="slider"/g) ?? []).length).toBe(3);
    expect(html).toContain('id="disciplines"');
    expect(html).toContain("Quest Log");
    expect(html).toContain("data-delta=");
    expect(html).toContain('id="confetti"');
    expect(html).toContain("function autoSolvePath");
    expect(html).toContain("GEMIT_CONST");
    expect(html).toContain("prefers-reduced-motion");
  });

  // Regression guard for a bug class the string-only assertion above cannot catch: a new
  // animation added anywhere in the stylesheet but forgotten in the reduce block. Rather
  // than pin the exact selector list (which churns every time a card animation is added),
  // walk every flat CSS rule in the sheet, collect the selectors of any rule that declares
  // a real (non-"none") animation, and assert each one is textually present inside the
  // `prefers-reduced-motion: reduce` block. Flat-rule regex is safe here because CSS rule
  // *bodies* never contain braces — only at-rule wrappers (@media, @keyframes) do, and
  // those wrappers simply fail to match this pattern and get skipped.
  it("covers every animated selector under prefers-reduced-motion, not just the string", () => {
    const html = renderRpgTheme(data());
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    if (!styleMatch) throw new Error("no <style> block found");
    // Strip comments first — the flat-rule regex below treats "any text between braces" as
    // a selector, and a comment sitting just above a rule (there are several multi-line
    // design-rationale ones in this sheet) has no braces of its own, so it would otherwise
    // get swallowed into the selector text of the rule that follows it.
    const css = styleMatch[1].replace(/\/\*[\s\S]*?\*\//g, "");

    const reduceStart = css.indexOf("@media (prefers-reduced-motion: reduce)");
    if (reduceStart === -1) throw new Error("no prefers-reduced-motion block found");
    const braceStart = css.indexOf("{", reduceStart);
    let depth = 0, i = braceStart;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") { depth--; if (depth === 0) break; }
    }
    const reduceBlock = css.slice(braceStart + 1, i);

    const animatedSelectors: string[] = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, selector, decl] = m;
      if (/\banimation:\s*(?!none\b)/.test(decl)) animatedSelectors.push(selector.trim());
    }
    // Sanity: the stylesheet must actually declare more than one animated rule, or this
    // test would pass vacuously.
    expect(animatedSelectors.length).toBeGreaterThanOrEqual(6);
    for (const selector of animatedSelectors) {
      expect(reduceBlock).toContain(selector);
    }
    expect(css).not.toContain(".stamp"); // dead: no markup targets it any more
  });

  it("keeps the doorway static: no script, no disciplines", () => {
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

describe("the disciplines collapse", () => {
  it("renders each discipline exactly once — no twin section", () => {
    const html = renderRpgTheme(data());
    expect((html.match(/Context Discipline/g) ?? []).length).toBe(1);
    expect((html.match(/Process Quality/g) ?? []).length).toBe(1);
    expect((html.match(/Setup Maturity/g) ?? []).length).toBe(1);
    expect(html).not.toContain('id="training"');
    expect(html).not.toContain("Training Grounds");
  });

  it("keeps three slider handles and the what-if toggle on one set of bars", () => {
    const html = renderRpgTheme(data());
    expect((html.match(/role="slider"/g) ?? []).length).toBe(3);
    expect(html).toContain('class="wi"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("keeps the projection readout and the auto-solve button", () => {
    const html = renderRpgTheme(data());
    expect(html).toContain('id="tg-comp"');
    expect(html).toContain('id="tg-tier"');
    expect(html).toContain('id="tg-solve"');
  });

  it("every track's aria references resolve to an id that exists in the document", () => {
    const html = renderRpgTheme(data());
    const trackOpenTags = html.match(/<div class="track"[^>]*>/g) ?? [];
    expect(trackOpenTags.length).toBe(3);
    for (const tag of trackOpenTags) {
      const ids = [...tag.matchAll(/aria-(?:labelledby|describedby)="([^"]+)"/g)].map((m) => m[1]);
      expect(ids.length).toBe(2);
      for (const id of ids) expect(html).toContain(`id="${id}"`);
    }
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

describe("house style adoption", () => {
  it("builds on the shared token vocabulary rather than private colours", () => {
    const html = renderRpgTheme(data());
    expect(html).toContain("--surface:");
    expect(html).toContain("--ink:");
    expect(html).toContain("--serif:");
    expect(html).toContain("--mono:");
    expect(html).not.toContain("--panel2");   // retired private token
  });

  it("orders the dossier with the actionable section first", () => {
    const html = renderRpgTheme(data());
    // "The Record" alone would also match the seam's "The Record Behind It" copy that
    // precedes both sections unconditionally — anchor on the actual heading instead.
    expect(html.indexOf("Quest Log")).toBeLessThan(html.indexOf("Techniques Unlocked"));
    expect(html.indexOf("Techniques Unlocked")).toBeLessThan(html.indexOf("<h2>The Record</h2>"));
  });

  it("declares --gold once so every var(--gold) reference in the dossier resolves", () => {
    const html = renderRpgTheme(data());
    expect(html).toContain("--gold:");
    expect(html).toContain("var(--gold)");
  });

  it("still ships no external URL after adopting house tokens", () => {
    expect(renderRpgTheme(data())).not.toMatch(/https?:\/\//);
  });
});

describe("renderRpgTheme usage section", () => {
  it("lists coding agents with session counts, plus top skills and subagents", () => {
    const html = renderRpgTheme(data());
    expect(html).toContain("What You Reach For");
    expect(html).toContain("Coding agents");
    expect(html).toContain("claude");
    expect(html).toContain("cursor");
    expect(html).toContain("brainstorming");
    expect(html).toContain("Explore");
  });

  // shareVariantOf blanks all three lists, so the shared card renders this section with
  // nothing in it. It must vanish entirely rather than leaving a bare heading behind.
  it("omits the whole section when every list is empty", () => {
    const html = renderRpgTheme(data({ agents: [], topSkills: [], topSubagents: [] }));
    expect(html).not.toContain("What You Reach For");
    expect(html).not.toContain("Coding agents");
  });

  it("omits only the blocks that are empty, keeping the ones that are not", () => {
    const html = renderRpgTheme(data({ topSkills: [], topSubagents: [] }));
    expect(html).toContain("What You Reach For");
    expect(html).toContain("Coding agents");
    expect(html).not.toContain("Most-used skills");
    expect(html).not.toContain("Most-used subagents");
  });

  it("escapes names rather than trusting them as markup", () => {
    const html = renderRpgTheme(data({ topSkills: ['<img src=x onerror="alert(1)">'] }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

// The report is rendered for three different surfaces and only ONE of them may carry
// share links. Getting this wrong is invisible to the eye — the buttons render fine and
// simply do nothing — so it is pinned by tests rather than by a comment alone.
describe("renderRpgTheme share surfaces", () => {
  const links = {
    shareUrl: "https://app.agentgem.ai/games/tester/gemit-2026-07-19",
    x: "https://x.com/intent/post?text=hi",
    linkedin: "https://www.linkedin.com/sharing/share-offsite/?url=hi",
    facebook: "https://www.facebook.com/sharer/sharer.php?u=hi",
  };

  it("offers the copyable publish command when the report has not been published", () => {
    const html = renderRpgTheme(data());
    expect(html).toContain("agentgem gemit --share");
    // reuses the existing .cmd-copy machinery rather than shipping a second copy handler
    expect(html).toMatch(/<code>agentgem gemit --share<\/code><button type="button" class="cmd-copy">/);
  });

  it("swaps the command for real intent links once share links are supplied", () => {
    const html = renderRpgTheme(data(), { share: links });
    for (const url of [links.x, links.linkedin, links.facebook, links.shareUrl]) {
      expect(html).toContain(url);
    }
    // the CTA is replaced, not appended — a published sheet must not still say "run --share"
    expect(html).not.toContain("<code>agentgem gemit --share</code>");
    // every outbound anchor opens away from the report and leaks no referrer
    for (const m of html.matchAll(/<a href="https:\/\/(?:x\.com|www\.linkedin|www\.facebook)[^"]*"([^>]*)>/g)) {
      expect(m[1]).toContain('target="_blank"');
      expect(m[1]).toContain("noopener");
    }
  });

  // THE load-bearing one. The marketplace plays a card in `sandbox="allow-scripts"` with
  // no allow-popups and no allow-top-navigation, so a share link embedded in the shipped
  // copy is silently unclickable. The sealed render must therefore carry no share region
  // at all — a dead button is worse than no button.
  it("emits no share affordance whatsoever in the sealed copy that ships as the card", () => {
    const html = renderRpgTheme(data(), { sealed: true });
    expect(html).not.toContain("agentgem gemit --share");
    // assert on MARKUP, not the bare class name — the stylesheet is inlined verbatim on
    // every surface, so `.share-bar`'s rule is present even where the section is not
    expect(html).not.toContain('<section class="share-out">');
    expect(html).not.toContain('class="share-bar"');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("keeps the share region off the insufficient-data doorway, which has nothing to publish", () => {
    const d = data({ insufficient: true, qualifyingSessions: 2, composite: 0, tierLevel: 1 });
    expect(renderRpgTheme(d)).not.toContain("agentgem gemit --share");
    expect(renderRpgTheme(d, { share: links })).not.toContain(links.x);
  });

  // Text-only dimming must never be element-level `opacity` on a selector that also owns a
  // border/background or an interactive/inherited-colour child — opacity composites the whole
  // box and multiplies with a child's own opacity, washing out chrome that was never muted and
  // compounding with the child's independent fade. Assert the property, not the exact
  // `color-mix` string, so an equivalent future mechanism (a different alpha function, say)
  // doesn't fail this spuriously.
  it("dims text via colour, not container opacity, on the muted-to-dimmed selectors", () => {
    const html = renderRpgTheme(data());
    const ruleFor = (pattern: RegExp): string => {
      const m = html.match(pattern);
      if (!m) throw new Error(`rule not found for ${pattern}`);
      return m[0];
    };
    for (const pattern of [/\bh2\s*\{[^}]*\}/, /\.provenance\s*\{[^}]*\}/, /\.quests \.chip\.assumed\s*\{[^}]*\}/]) {
      const rule = ruleFor(pattern);
      expect(rule).toMatch(/color:/);
      expect(rule).not.toMatch(/\bopacity:/);
    }
  });

  it("gives .wi its own colour instead of inheriting a dimmed ancestor's, so only its own opacity applies", () => {
    const html = renderRpgTheme(data());
    const m = html.match(/\.wi\s*\{[^}]*\}/);
    if (!m) throw new Error("base .wi rule not found");
    expect(m[0]).not.toMatch(/color:\s*inherit/);
    expect(m[0]).toMatch(/opacity:\s*\.75/);
  });
});
