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

import { COHORT, cohortLabel, percentileFor } from "./cohort.js";
import { COMPOSITE_WEIGHTS, SETUP_WEIGHTS, TIER_THRESHOLDS, type GemitData } from "./score.js";
import { autoSolvePath, projectComposite, setupScoreFrom, tierFor } from "./themeRpgSim.js";
import { STYLES } from "./theme/styles.js";
import { RUNTIME_JS } from "./theme/runtime.js";

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

export interface Quest {
  id: string; title: string; remedy: string; axis: "ctx" | "proc" | "setup";
  delta: number; exact: boolean; meter?: { now: number; target: number; label: string }; cmd?: string;
}

const FINDING_AXIS: Record<string, "ctx" | "proc"> = {
  "reread-churn": "ctx", "context-bloat": "ctx",
  "no-verify-finish": "proc", "retry-storm": "proc", "repeated-tool-error": "proc",
};
const FINDING_REMEDIES: Record<string, string> = {
  "no-verify-finish": "End with proof — run the tests or reload the page before calling it done.",
  "retry-storm": "Two failed retries means the approach is wrong. Stop and rethink; don't hammer.",
  "repeated-tool-error": "Fix the first tool error before moving on; repeats compound into noise.",
  "reread-churn": "Re-reading the same file is context leak — take notes or delegate to a subagent.",
};

// Locked perks + top fired findings become actionable quests. Setup deltas are EXACT
// (recomputed via setupScoreFrom when the share fields shipped); ctx/proc deltas are
// assumptions and rendered with a "~" chip. Old cards without the share fields degrade
// every setup quest to assumed.
export function questsFor(d: GemitData): Quest[] {
  const { locked } = perksFor(d);
  const canExact = typeof d.skillSessionsPct === "number" && typeof d.subagentSessionsPct === "number";
  const setupNow = canExact ? setupScoreFrom(d, SETUP_WEIGHTS) : 0;
  const exactDelta = (patch: Partial<GemitData>): number =>
    Math.max(1, setupScoreFrom({ ...d, ...patch }, SETUP_WEIGHTS) - setupNow);
  const quests: Quest[] = [];
  const boundedPct = d.scoredSessions ? Math.round((100 * d.verdicts.bounded) / d.scoredSessions) : 0;
  for (const p of locked) {
    if (p.name === "Shadow Clones") quests.push({
      id: "perk-shadow-clones", title: "Unlock Shadow Clones", axis: "setup",
      delta: canExact ? exactDelta({ subagentVariety: 5 }) : 3, exact: canExact,
      remedy: "Adopt more subagent types — delegate exploration, review, and bulk reads.",
      meter: { now: d.subagentVariety, target: 5, label: `${d.subagentVariety}/5 subagent types` },
      cmd: "npx -y @ninemind/agentgem",
    });
    else if (p.name === "Scroll Mastery") quests.push({
      id: "perk-scroll-mastery", title: "Unlock Scroll Mastery", axis: "setup",
      delta: canExact ? exactDelta({ skillVariety: 8 }) : 3, exact: canExact,
      remedy: "Install and invoke more skills — the book fights better than improvisation.",
      meter: { now: d.skillVariety, target: 8, label: `${d.skillVariety}/8 skills` },
      cmd: "npx -y @ninemind/agentgem",
    });
    else if (p.name === "Second Look") quests.push({
      id: "perk-second-look", title: "Unlock Second Look", axis: "proc", delta: 4, exact: false,
      remedy: "Ask for verification before accepting done — tests run, page reloaded, output shown.",
      meter: { now: d.verifyRatePct ?? 0, target: 60, label: `${d.verifyRatePct ?? 0}/60% verified` },
    });
    else if (p.name === "Shadow Step") quests.push({
      id: "perk-shadow-step", title: "Unlock Shadow Step", axis: "ctx", delta: 4, exact: false,
      remedy: "Keep sessions bounded — fresh session per task, /clear early, delegate bulk reads.",
      meter: { now: boundedPct, target: 80, label: `${boundedPct}/80% bounded` },
    });
    else if (p.name === "Clean Cut") quests.push({
      id: "perk-clean-cut", title: "Unlock Clean Cut", axis: "ctx", delta: 3, exact: false,
      remedy: "Chain bounded sessions — the streak grows one disciplined session at a time.",
      meter: { now: d.boundedStreak, target: 20, label: `${d.boundedStreak}/20 streak` },
    });
  }
  for (const f of d.firedFindings.slice(0, 3)) quests.push({
    id: `finding-${f.id}`, title: `Quiet “${f.title}”`, axis: FINDING_AXIS[f.id] ?? "proc",
    delta: 5, exact: false,
    remedy: FINDING_REMEDIES[f.id] ?? `Fired in ${f.sessions} of ${d.scoredSessions} scored sessions — make its trigger rare.`,
  });
  return quests;
}

const statBar = (label: string, value: number, low: boolean, i: number): string => `
      <div class="stat">
        <div class="stat-head"><span class="stat-name">${label}</span><span class="stat-val mono">${value}</span></div>
        <div class="bar${low ? " low" : ""}"><i style="--w:${value}%;--d:${(0.15 + i * 0.12).toFixed(2)}s"></i></div>
      </div>`;

const tgStat = (label: string, axis: string, v: number): string => `
      <div class="tg-stat" data-axis="${axis}">
        <div class="stat-head"><span class="stat-name">${label}</span><span class="tg-val mono">${v}</span></div>
        <div class="tg-bar" role="slider" tabindex="0" aria-label="Projected ${label}" aria-valuemin="${v}" aria-valuemax="100" aria-valuenow="${v}">
          <i class="tg-meas" style="--w:${v}%"></i><i class="tg-proj" style="width:${v}%"></i>
        </div>
      </div>`;

const questLi = (q: Quest): string => `
        <li data-axis="${q.axis}" data-delta="${q.delta}">
          <label><input type="checkbox"><b>${escapeHtml(q.title)}<span class="chip${q.exact ? "" : " assumed"}">${q.exact ? "+" : "~+"}${q.delta} ${q.axis.toUpperCase()}</span></b></label>
          ${q.meter ? `<span class="meter"><i style="--p:${Math.min(100, Math.round((100 * q.meter.now) / q.meter.target))}%"></i></span><span class="meter-label mono">${escapeHtml(q.meter.label)}</span><br>` : ""}${escapeHtml(q.remedy)}
          ${q.cmd ? `<span class="cmd-line"><code>${escapeHtml(q.cmd)}</code><button type="button" class="cmd-copy">Copy</button></span>` : ""}
        </li>`;

const perkLi = (p: Perk, locked: boolean): string => `
        <li${locked ? ' class="locked"' : ""}><b>${escapeHtml(p.name)}${locked ? " · locked" : ""}</b>${escapeHtml(p.detail)}</li>`;

const RING_C = 339.3; // 2πr, r=54

function renderCard(d: GemitData): string {
  const tierName = TIER_NAMES[d.tierLevel - 1];
  const nextTier = d.tierLevel < 4 ? TIER_NAMES[d.tierLevel as 1 | 2 | 3] : null;
  const ptsToNext = nextTier ? [50, 65, 80][d.tierLevel - 1] - d.composite : 0;
  const hook = nextTier
    ? `${ptsToNext} pt${ptsToNext === 1 ? "" : "s"} from ${nextTier}`
    : "Top tier";
  const pct = percentileFor(d.composite, COHORT);
  const cohort = pct !== null && COHORT
    ? `<p class="cohort">Top <b>${100 - pct}%</b> &middot; ${escapeHtml(cohortLabel(COHORT))}</p>`
    : "";
  const { unlocked } = perksFor(d);
  const offset = (RING_C * (1 - d.composite / 100)).toFixed(1);
  const pip = (label: string, v: number, i: number): string => `
        <div class="pip${v < 50 ? " low" : ""}"><span>${label}</span><b class="mono">${v}</b>
          <i style="--w:${v}%;--d:${(0.25 + i * 0.12).toFixed(2)}s"></i></div>`;

  return `
    <section class="card">
      <p class="eyebrow">AgentGem &middot; Steering Assessment &middot; ${d.windowFrom} &rarr; ${d.windowTo}</p>
      <div class="crown">
        <div class="ring">
          <svg viewBox="0 0 132 132" aria-hidden="true"><circle class="trk" cx="66" cy="66" r="54"/><circle class="arc" cx="66" cy="66" r="54" style="stroke-dashoffset:${offset}"/></svg>
          <div class="num"><b class="mono count" data-n="${d.composite}">${d.composite}</b><span class="mono">/ 100</span></div>
        </div>
        <div class="crown-txt">
          <h1 class="tier">${tierName}</h1>
          <p class="flavor">${TIER_FLAVOR[d.tierLevel - 1]}</p>
          ${cohort}
          <span class="hook">${hook}</span>
        </div>
      </div>
      <div class="pips">${pip("Context", d.ctx, 0)}${pip("Process", d.proc, 1)}${pip("Setup", d.setup, 2)}
      </div>
      <div class="strip">
        <span class="gems">${"◈".repeat(unlocked.length)}${"◇".repeat(5 - unlocked.length)} <span>${unlocked.length}/5 techniques</span></span>
        <span>&#9889; ${d.boundedStreak}-session streak</span>
      </div>
    </section>`;
}

export function renderRpgTheme(data: GemitData): string {
  const tierName = TIER_NAMES[data.tierLevel - 1];
  const { unlocked } = perksFor(data);
  const quests = questsFor(data);
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  // The sim trio ships as its own source (plain tsc output — never minified); the doorway
  // stays script-free because GEMIT_CONST carries tier names the doorway must not show.
  const simSrc = [projectComposite, tierFor, autoSolvePath].map((f) => f.toString()).join("\n");
  const constJson = JSON.stringify({ weights: COMPOSITE_WEIGHTS, thresholds: TIER_THRESHOLDS, tierNames: TIER_NAMES }).replace(/</g, "\\u003c");
  const script = data.insufficient ? "" : `<div id="confetti"></div>
<script>"use strict";
const GEMIT_CONST=${constJson};
${simSrc}
${RUNTIME_JS}</script>`;

  const body = data.insufficient ? `
    <header class="hero">
      <p class="eyebrow">AgentGem &middot; Steering Assessment</p>
      <h1 class="rank">No score yet</h1>
      <p class="conferred">Fewer than 5 substantial sessions in the last 30 days
        (found ${data.qualifyingSessions}). Steer a few agent sessions and run
        <span class="mono">agentgem gemit</span> again &mdash; the sheet fills itself.</p>
    </header>` : `
    ${renderCard(data)}
    <div class="seam"><span>The Record Behind It</span></div>

    <section>
      <h2>The Three Disciplines</h2>
      ${statBar("Context Discipline", data.ctx, data.ctx < 50, 0)}
      ${statBar("Process Quality", data.proc, data.proc < 50, 1)}
      ${statBar("Setup Maturity", data.setup, data.setup < 50, 2)}
    </section>

    <section id="training">
      <h2>Training Grounds</h2>
      <p class="tg-note">What if? Drag a bar or take on quests below &mdash; the measured score above never moves.</p>
      ${tgStat("Context Discipline", "ctx", data.ctx)}
      ${tgStat("Process Quality", "proc", data.proc)}
      ${tgStat("Setup Maturity", "setup", data.setup)}
      <p class="tg-rank mono">PROJECTED <span id="tg-comp">${data.composite}</span> / 100 &mdash; <span id="tg-tier">${tierName}</span></p>
      <button id="tg-solve" type="button"${data.tierLevel >= 4 ? " disabled" : ""}>${data.tierLevel >= 4 ? "You&#39;re at the summit" : `Chart my path to ${TIER_NAMES[3]}`}</button>
    </section>

    ${unlocked.length ? `<section><h2>Techniques Unlocked</h2><ul class="jutsu">${unlocked.map((p) => perkLi(p, false)).join("")}
      </ul></section>` : ""}
    ${quests.length ? `<section><h2>Quest Log</h2><ul class="jutsu quests">${quests.map(questLi).join("")}
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
<style>${STYLES}</style>
<script type="application/json" id="gemit-data">${json}</script>
</head>
<body>
<main><div class="frame">${body}
</div></main>
${script}
</body>
</html>
`;
}
