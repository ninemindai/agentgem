// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemit/themeRpg.ts
//
// The default `rpg` theme: renders a GemitData payload as a self-contained
// character-sheet HTML document. Pure presentation — scoring never varies by
// theme, so cards stay comparable across styles. The template is a TS string
// builder (never a runtime-read file: the npm tarball ships dist/ only), fully
// inline (no external URLs), dual-theme via :root[data-theme] tokens, with the
// payload baked as a JSON island for future tooling.

import type { GemitData } from "./score.js";

export const TIER_NAMES = ["Prospector", "Cutter", "Lapidary", "Master Lapidary"] as const;

const TIER_FLAVOR = [
  "You're finding the veins.",
  "Clean breaks, most days.",
  "The window stays lean; done means verified.",
  "The harness works for you.",
] as const;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const fmt = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
  : String(n);

interface Perk { name: string; detail: string }

// Perks derive from thresholds on real aggregates — flavor is playful, numbers honest.
export function perksFor(d: GemitData): { unlocked: Perk[]; locked: Perk[] } {
  const boundedRate = d.scoredSessions ? d.verdicts.bounded / d.scoredSessions : 0;
  const all: Array<Perk & { on: boolean }> = [
    {
      name: "Shadow Step", on: boundedRate >= 0.8,
      detail: `${d.verdicts.bounded} of ${d.scoredSessions} scored sessions stayed bounded — the context window never fights back.`,
    },
    {
      name: "Shadow Clones", on: d.subagentVariety >= 5,
      detail: `Delegates across ${d.subagentVariety} subagent types. The work multiplies; the window doesn't.`,
    },
    {
      name: "Scroll Mastery", on: d.skillVariety >= 8,
      detail: `${d.skillVariety} distinct skills invoked — fights by the book when it counts.`,
    },
    {
      name: "Clean Cut", on: d.boundedStreak >= 20,
      detail: `Longest bounded streak: ${d.boundedStreak} consecutive scored sessions.`,
    },
    {
      name: "Second Look", on: (d.verifyRatePct ?? 0) >= 60,
      detail: `Verifies before finishing in ${d.verifyRatePct ?? 0}% of sessions.`,
    },
  ];
  return {
    unlocked: all.filter((p) => p.on).map(({ name, detail }) => ({ name, detail })),
    locked: all.filter((p) => !p.on).map(({ name, detail }) => ({ name, detail })),
  };
}

const statBar = (label: string, value: number, low: boolean): string => `
      <div class="stat">
        <div class="stat-head"><span class="stat-name">${label}</span><span class="stat-val mono">${value}</span></div>
        <div class="bar${low ? " low" : ""}"><i style="--w:${value}%"></i></div>
      </div>`;

const perkLi = (p: Perk, locked: boolean): string => `
        <li${locked ? ' class="locked"' : ""}><b>${escapeHtml(p.name)}${locked ? " · locked" : ""}</b>${escapeHtml(p.detail)}</li>`;

export function renderRpgTheme(data: GemitData): string {
  const tierName = TIER_NAMES[data.tierLevel - 1];
  const { unlocked, locked } = perksFor(data);
  const shadows = data.firedFindings.slice(0, 3);
  // Next tier's threshold: [50, 65, 80] indexed by the CURRENT level (1→50, 2→65, 3→80).
  const nextTier = data.tierLevel < 4 ? TIER_NAMES[data.tierLevel as 1 | 2 | 3] : null;
  const ptsToNext = nextTier ? [50, 65, 80][data.tierLevel - 1] - data.composite : 0;
  const rankLine = nextTier
    ? `RANK ${data.composite} / 100 &mdash; ${ptsToNext} pt${ptsToNext === 1 ? "" : "s"} from ${nextTier}`
    : `RANK ${data.composite} / 100 &mdash; top tier`;
  const json = JSON.stringify(data).replace(/</g, "\\u003c");

  const body = data.insufficient ? `
    <header class="hero">
      <p class="eyebrow">AgentGem &middot; Steering Assessment</p>
      <h1 class="rank">No score yet</h1>
      <p class="conferred">Fewer than 5 substantial sessions in the last 30 days
        (found ${data.qualifyingSessions}). Steer a few agent sessions and run
        <span class="mono">agentgem gemit</span> again &mdash; the sheet fills itself.</p>
    </header>` : `
    <header class="hero">
      <p class="eyebrow">AgentGem &middot; Steering Assessment &middot; ${data.windowFrom} &rarr; ${data.windowTo}</p>
      <h1 class="rank">${tierName}</h1>
      <p class="flavor">${TIER_FLAVOR[data.tierLevel - 1]}</p>
      <p class="composite mono">${rankLine}</p>
    </header>

    <section>
      <h2>The Three Disciplines</h2>
      ${statBar("Context Discipline", data.ctx, data.ctx < 50)}
      ${statBar("Process Quality", data.proc, data.proc < 50)}
      ${statBar("Setup Maturity", data.setup, data.setup < 50)}
    </section>

    ${unlocked.length ? `<section><h2>Techniques Unlocked</h2><ul class="jutsu">${unlocked.map((p) => perkLi(p, false)).join("")}
      </ul></section>` : ""}
    ${locked.length ? `<section><h2>Still Sealed</h2><ul class="jutsu">${locked.map((p) => perkLi(p, true)).join("")}
      </ul></section>` : ""}
    ${shadows.length ? `<section><h2>Shadows to Train</h2><ul class="jutsu train">${shadows.map((f) => `
        <li><b>${escapeHtml(f.title)}</b>Fired in <span class="count mono">${f.sessions}</span> of ${data.scoredSessions} scored sessions.</li>`).join("")}
      </ul></section>` : ""}

    <section>
      <h2>The Record</h2>
      <div class="grid mono">
        <div class="cell"><div class="n">${fmt(data.qualifyingSessions)}</div><div class="l">sessions &middot; 30d</div></div>
        <div class="cell"><div class="n">${data.projects}</div><div class="l">projects</div></div>
        <div class="cell"><div class="n">${fmt(data.totalMsgs)}</div><div class="l">messages</div></div>
        <div class="cell"><div class="n">${fmt(data.tokensOut)}</div><div class="l">tokens out</div></div>
      </div>
    </section>

    <footer class="provenance">
      Scored on the ${data.scoredSessions} most recent substantial sessions of
      ${data.qualifyingSessions} in window &middot; deterministic detectors (context hygiene +
      process quality), no LLM in the loop &middot; same transcripts, same sheet.
    </footer>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${data.insufficient ? "gemit — no score yet" : `${tierName} — Agent Steering Report`}</title>
<style>
  :root {
    --bg: #10141f; --panel: #1a2130; --panel2: #151b28; --ink: #e8dfc8;
    --muted: #8b96ad; --accent: #c8372e; --gold: #d9a441; --line: #2a3347;
  }
  :root[data-theme="light"] {
    --bg: #f4f1e8; --panel: #ffffff; --panel2: #ece7d8; --ink: #23293a;
    --muted: #5b6577; --accent: #a02c24; --gold: #8a6519; --line: #d5cdb8;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      --bg: #f4f1e8; --panel: #ffffff; --panel2: #ece7d8; --ink: #23293a;
      --muted: #5b6577; --accent: #a02c24; --gold: #8a6519; --line: #d5cdb8;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: Georgia, "Times New Roman", serif; line-height: 1.6;
  }
  .mono { font-family: ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; }
  main { max-width: 700px; margin: 40px auto 64px; padding: 0 20px; }
  .frame { border: 1px solid var(--line); outline: 1px solid var(--line); outline-offset: 6px; padding: clamp(24px, 6vw, 48px); background: var(--panel2); }
  .eyebrow { font-family: ui-monospace, Menlo, monospace; font-size: 11px; letter-spacing: .26em; text-transform: uppercase; color: var(--muted); text-align: center; margin: 0 0 6px; }
  .hero { text-align: center; }
  .rank { font-size: clamp(44px, 11vw, 76px); margin: 6px 0 0; letter-spacing: .06em; text-transform: uppercase; color: var(--gold); }
  .flavor { color: var(--muted); font-style: italic; margin: 4px 0 0; }
  .composite { margin: 18px auto 0; width: fit-content; border: 1px solid var(--line); background: var(--panel); padding: 8px 16px; font-size: 14px; color: var(--muted); }
  .conferred { color: var(--muted); max-width: 44ch; margin: 14px auto 0; }
  h2 { font-size: 12.5px; letter-spacing: .22em; text-transform: uppercase; color: var(--muted); font-weight: 500; display: flex; align-items: center; gap: 12px; margin: 40px 0 16px; }
  h2::after { content: ""; height: 1px; background: var(--line); flex: 1; }
  .stat { margin: 0 0 16px; }
  .stat-head { display: flex; justify-content: space-between; align-items: baseline; }
  .stat-name { font-size: 15.5px; }
  .stat-val { font-size: 17px; }
  .bar { height: 8px; margin-top: 7px; background: var(--panel); border: 1px solid var(--line); overflow: hidden; }
  .bar i { display: block; height: 100%; width: var(--w); background: var(--gold); transform-origin: left; animation: fill 1s cubic-bezier(.25,1,.3,1) .15s backwards; }
  .bar.low i { background: var(--accent); }
  @keyframes fill { from { transform: scaleX(0); } }
  ul.jutsu { list-style: none; padding: 0; margin: 0; display: grid; gap: 9px; }
  ul.jutsu li { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--gold); padding: 11px 15px; font-size: 14px; color: var(--muted); }
  ul.jutsu li b { color: var(--ink); display: block; font-size: 14.5px; }
  ul.jutsu li.locked { opacity: .55; border-left-style: dashed; }
  ul.jutsu.train li { border-left-color: var(--accent); }
  .count { color: var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 9px; }
  .cell { background: var(--panel); border: 1px solid var(--line); padding: 12px 14px; }
  .cell .n { font-size: 21px; }
  .cell .l { font-size: 11.5px; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); margin-top: 2px; }
  .provenance { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--muted); line-height: 1.7; }
  @media (prefers-reduced-motion: reduce) { .bar i { animation: none; } }
</style>
<script type="application/json" id="gemit-data">${json}</script>
</head>
<body>
<main><div class="frame">${body}
</div></main>
</body>
</html>
`;
}
