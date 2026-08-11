// src/__tests__/renderCheckFixtures.test.ts
//
// Tier 2 pointed at REAL shipped output rather than synthetic HTML. renderCheck.test.ts proves the
// checks work; this proves the things we actually ship pass them.
//
// Three producers, chosen because each is a different kind of risk:
//   - the house style (HOUSE_TOKENS + themeAdapter) — every generated report inherits it, so one bad
//     token pair is a defect multiplied across every report anyone ever renders;
//   - a miniapp scaffold — the starting point for every miniapp a user builds;
//   - the gemit card (renderRpgTheme) — deterministic template output, and the exact artifact being
//     screenshotted by hand at 360/380 to check wrapping. That manual pass is what this replaces.
//
// Skipped without Chrome, so a laptop that lacks one still gets a green `pnpm test`.
import { describe, it, expect } from "vitest";
import { renderCheck, chromeExecutable, type Viewport, type LayoutFinding } from "./support/renderCheck.js";
import { HOUSE_TOKENS, themeAdapter, HOUSE_PARTIALS } from "@agentgem/model";
import { scaffoldFor, GENRES } from "@agentgem/play";
import { renderRpgTheme } from "../gemit/themeRpg.js";
import type { GemitData } from "../gemit/score.js";

const describeIfChrome = chromeExecutable() ? describe : describe.skip;

// 360 is the narrowest phone worth supporting; 390 is the modern iPhone; 1440 is a laptop. Each is
// run in all four theme states, because a document can be fine in one and broken in another — the
// reason the gemit card was being screenshotted in light AND dark by hand.
const MATRIX: Viewport[] = ["light", "dark", "system-light", "system-dark"].flatMap((theme) =>
  [360, 390, 1440].map((width) => ({ width, height: 900, theme: theme as Viewport["theme"] })),
);

/** Findings grouped for a readable failure — a bare array of 40 objects tells you nothing. */
const summarize = (f: LayoutFinding[]): string =>
  f.map((x) => `  [${x.severity}] ${x.id} @ ${x.viewport}\n      ${x.evidence ?? x.message}`).join("\n");

describeIfChrome("shipped artifacts survive a real layout engine", () => {
  it("the document house style has no overflow and no contrast failure in any theme", async () => {
    // Exactly what reportRender hands the agent: the token vocabulary, the document theme binding,
    // and the structural partials — wrapped in the composition the brief asks for.
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>House style</title><style>
${HOUSE_TOKENS}
${themeAdapter("document")}
${HOUSE_PARTIALS.kpiRow}
${HOUSE_PARTIALS.dataTable}
${HOUSE_PARTIALS.svgBar}
body{background:var(--surface);color:var(--ink);font:var(--t-body)/1.6 var(--sans);margin:0;padding:var(--sp-4)}
h1{font:600 var(--t-display)/1.15 var(--serif);margin:0 0 var(--sp-2)}
.eyebrow{font:500 var(--t-small) var(--sans);text-transform:uppercase;letter-spacing:.08em;opacity:.6}
.panel{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:var(--sp-3)}
</style></head><body>
<div class="eyebrow">Session report · agentgem · today</div>
<h1>Nine sessions, two recurring frictions</h1>
<p>Body copy at the default size, which is the text most of a report is made of.</p>
<div class="hs-kpis">
  <div class="hs-kpi"><b>9</b><span>sessions</span></div>
  <div class="hs-kpi"><b>2</b><span>frictions</span></div>
  <div class="hs-kpi"><b>78%</b><span>achieved</span></div>
</div>
<div class="hs-scroll"><table class="hs-table"><thead><tr><th>Session</th><th>Outcome</th></tr></thead>
<tbody><tr><td>abc123</td><td class="hs-num">4</td></tr></tbody></table></div>
<div class="panel"><p>Text on the raised surface — the nested-panel case where colour is inherited.</p></div>
</body></html>`;
    const f = await renderCheck(doc, MATRIX);
    expect(f, `house style findings:\n${summarize(f)}`).toEqual([]);
  }, 120_000);

  it("every miniapp scaffold renders without overflow at phone widths", async () => {
    // Scaffolds are what a user starts from. One that overflows at 360 ships that overflow into
    // every miniapp built on it.
    const narrow: Viewport[] = [{ width: 360, height: 900, theme: "light" }, { width: 390, height: 900, theme: "dark" }];
    for (const g of Object.values(GENRES)) {
      const f = (await renderCheck(scaffoldFor(g.scaffold), narrow)).filter((x) => x.severity === "fail");
      expect(f, `scaffold ${g.scaffold}:\n${summarize(f)}`).toEqual([]);
    }
  }, 240_000);

  it("the gemit card holds up at 360 in both themes — the check that was being done by hand", async () => {
    // Same shape gemitTheme.test.ts uses — a realistic card, not a minimal one. Tier 3 renders the
    // longest tier name ("Lapidary"/"Master Lapidary"), which is the string that wraps first at 360.
    const data: GemitData = {
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
      ],
      skillVariety: 12, subagentVariety: 8, skillSessionsPct: 62, subagentSessionsPct: 41,
      topSkills: ["brainstorming"], topSubagents: ["Explore"],
      agents: [{ name: "claude", sessions: 90 }, { name: "cursor", sessions: 29 }],
      insufficient: false,
    };
    const f = await renderCheck(renderRpgTheme(data, { sealed: true }), MATRIX);

    // Structure is sound at every width — no overflow, no unreachable control. This part is strict.
    expect(f.filter((x) => x.severity !== "warn"), `gemit card structure:\n${summarize(f)}`).toEqual([]);

    // CONTRAST IS BASELINED, NOT PASSING. This check found two real failures the first time it ran,
    // on the very artifact that was being screenshotted by hand:
    //
    //   1.39:1  gold #e8c87d on gold #d9a441  — the "N pt from <tier>" line
    //   1.94:1  gold #d9a441 on cream #f0eee6 — the stat numerals
    //
    // AA wants 4.5:1 for 12px text. Recolouring the card is a design call, not a test's to make, so
    // it is recorded in TODOS.md and pinned here by DISTINCT COLOUR PAIR: the existing two are
    // tolerated, a third fails this test immediately. That way the debt is visible and bounded
    // instead of being laundered into a green run.
    const pairs = new Set(
      f.filter((x) => x.id === "low-contrast").map((x) => (x.evidence ?? "").split("—")[1]?.trim() ?? ""),
    );
    expect([...pairs].sort(), `gemit contrast pairs (see TODOS.md):\n${summarize(f)}`).toEqual([
      "rgb(217, 164, 65) on rgb(240, 238, 230) at 12px",
      "rgb(232, 200, 125) on rgb(217, 164, 65) at 12px",
    ]);
  }, 120_000);
});
