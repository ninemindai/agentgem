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

import { COMPOSITE_WEIGHTS, SETUP_WEIGHTS, TIER_THRESHOLDS, type GemitData } from "./score.js";
import { autoSolvePath, projectComposite, setupScoreFrom, tierFor } from "./themeRpgSim.js";

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

// Page runtime: wires sliders/quests/confetti to the revived sim functions. Kept as a
// plain string (not serialized TS) because it touches the DOM. Count-up + bar-fill mean
// early screenshots show low numbers — same pre-delay caveat as the PR-1 stat bars.
const RUNTIME_JS = `(function () {
  var dataEl = document.getElementById("gemit-data");
  if (!dataEl) return;
  var D = JSON.parse(dataEl.textContent);
  if (D.insufficient) return;
  var W = GEMIT_CONST.weights, TH = GEMIT_CONST.thresholds, NAMES = GEMIT_CONST.tierNames;
  var reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  var rankEl = document.querySelector(".count");
  if (rankEl && !reduced) {
    var rankTarget = +rankEl.getAttribute("data-n"), r0 = null;
    var rtick = function (t) {
      if (r0 === null) r0 = t;
      var p = Math.min(1, (t - r0) / 900);
      rankEl.textContent = String(Math.round(rankTarget * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(rtick);
    };
    rankEl.textContent = "0";
    requestAnimationFrame(rtick);
  }

  var vals = { ctx: D.ctx, proc: D.proc, setup: D.setup };
  var meas = { ctx: D.ctx, proc: D.proc, setup: D.setup };
  var lastTier = tierFor(projectComposite(vals.ctx, vals.proc, vals.setup, W), TH);

  function confetti() {
    var host = document.getElementById("confetti");
    if (!host) return;
    var colors = ["#d9a441", "#c8372e", "#e8dfc8", "#8b96ad"];
    for (var i = 0; i < 30; i++) {
      var s = document.createElement("i");
      s.style.left = (5 + Math.random() * 90) + "%";
      s.style.background = colors[i % 4];
      s.style.animationDelay = (Math.random() * 0.25) + "s";
      host.appendChild(s);
    }
    setTimeout(function () { host.innerHTML = ""; }, 1900);
  }

  function recompute() {
    var comp = projectComposite(vals.ctx, vals.proc, vals.setup, W);
    var tier = tierFor(comp, TH);
    var compEl = document.getElementById("tg-comp");
    if (compEl) compEl.textContent = String(comp);
    var tierEl = document.getElementById("tg-tier");
    if (tierEl && tier !== lastTier) {
      tierEl.textContent = NAMES[tier - 1];
      tierEl.classList.remove("flip"); void tierEl.offsetWidth; tierEl.classList.add("flip");
      if (tier > lastTier && !reduced) confetti();
      lastTier = tier;
    }
    var btn = document.getElementById("tg-solve");
    if (btn) btn.disabled = tier >= 4;
  }

  function setAxis(axis, v) {
    v = Math.max(meas[axis], Math.min(100, Math.round(v)));
    vals[axis] = v;
    var box = document.querySelector('.tg-stat[data-axis="' + axis + '"]');
    if (!box) return;
    box.querySelector(".tg-val").textContent = String(v);
    var bar = box.querySelector(".tg-bar");
    bar.setAttribute("aria-valuenow", String(v));
    bar.querySelector(".tg-proj").style.width = v + "%";
    recompute();
  }

  Array.prototype.forEach.call(document.querySelectorAll(".tg-stat"), function (box) {
    var axis = box.getAttribute("data-axis");
    var bar = box.querySelector(".tg-bar");
    var dragging = false;
    var fromEvent = function (e) {
      var r = bar.getBoundingClientRect();
      setAxis(axis, 100 * (e.clientX - r.left) / r.width);
    };
    bar.addEventListener("pointerdown", function (e) {
      dragging = true;
      if (bar.setPointerCapture) bar.setPointerCapture(e.pointerId);
      fromEvent(e); e.preventDefault();
    });
    bar.addEventListener("pointermove", function (e) { if (dragging) fromEvent(e); });
    bar.addEventListener("pointerup", function () { dragging = false; });
    bar.addEventListener("pointercancel", function () { dragging = false; });
    bar.addEventListener("keydown", function (e) {
      var step = e.shiftKey ? 5 : 1;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") { setAxis(axis, vals[axis] + step); e.preventDefault(); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { setAxis(axis, vals[axis] - step); e.preventDefault(); }
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll(".quests input[type=checkbox]"), function (cb) {
    cb.addEventListener("change", function () {
      var li = cb.closest("li");
      var axis = li.getAttribute("data-axis");
      var delta = +li.getAttribute("data-delta");
      setAxis(axis, vals[axis] + (cb.checked ? delta : -delta));
      li.classList.toggle("done", cb.checked);
    });
  });

  var solveBtn = document.getElementById("tg-solve");
  if (solveBtn) solveBtn.addEventListener("click", function () {
    var goal = autoSolvePath({ ctx: vals.ctx, proc: vals.proc, setup: vals.setup }, 4, W, TH);
    var from = { ctx: vals.ctx, proc: vals.proc, setup: vals.setup };
    if (reduced) { setAxis("ctx", goal.ctx); setAxis("proc", goal.proc); setAxis("setup", goal.setup); return; }
    var t0 = null;
    var tick = function (t) {
      if (t0 === null) t0 = t;
      var p = Math.min(1, (t - t0) / 1200), e2 = 1 - Math.pow(1 - p, 3);
      setAxis("ctx", from.ctx + (goal.ctx - from.ctx) * e2);
      setAxis("proc", from.proc + (goal.proc - from.proc) * e2);
      setAxis("setup", from.setup + (goal.setup - from.setup) * e2);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  function selectNode(node) {
    var sel = window.getSelection(), range = document.createRange();
    range.selectNodeContents(node); sel.removeAllRanges(); sel.addRange(range);
  }
  Array.prototype.forEach.call(document.querySelectorAll(".cmd-copy"), function (btn) {
    btn.addEventListener("click", function () {
      var code = btn.parentElement.querySelector("code");
      var done = function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy"; }, 1500); };
      try { navigator.clipboard.writeText(code.textContent).then(done, function () { selectNode(code); }); }
      catch (e) { selectNode(code); }
    });
  });
})();`;

const perkLi = (p: Perk, locked: boolean): string => `
        <li${locked ? ' class="locked"' : ""}><b>${escapeHtml(p.name)}${locked ? " · locked" : ""}</b>${escapeHtml(p.detail)}</li>`;

export function renderRpgTheme(data: GemitData): string {
  const tierName = TIER_NAMES[data.tierLevel - 1];
  const { unlocked } = perksFor(data);
  const quests = questsFor(data);
  // Next tier's threshold: [50, 65, 80] indexed by the CURRENT level (1→50, 2→65, 3→80).
  const nextTier = data.tierLevel < 4 ? TIER_NAMES[data.tierLevel as 1 | 2 | 3] : null;
  const ptsToNext = nextTier ? [50, 65, 80][data.tierLevel - 1] - data.composite : 0;
  const rankSpan = `<span class="count" data-n="${data.composite}">${data.composite}</span>`;
  const rankLine = nextTier
    ? `RANK ${rankSpan} / 100 &mdash; ${ptsToNext} pt${ptsToNext === 1 ? "" : "s"} from ${nextTier}`
    : `RANK ${rankSpan} / 100 &mdash; top tier`;
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
    <header class="hero">
      <p class="eyebrow">AgentGem &middot; Steering Assessment &middot; ${data.windowFrom} &rarr; ${data.windowTo}</p>
      <h1 class="rank stamp">${tierName}</h1>
      <p class="flavor">${TIER_FLAVOR[data.tierLevel - 1]}</p>
      <p class="composite mono">${rankLine}</p>
    </header>

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
  .bar i { display: block; height: 100%; width: var(--w); background: var(--gold); transform-origin: left; animation: fill 1s cubic-bezier(.25,1,.3,1) var(--d, .15s) backwards; }
  .bar.low i { background: var(--accent); }
  @keyframes fill { from { transform: scaleX(0); } }
  .tg-note { color: var(--muted); font-size: 13px; margin: 0 0 14px; }
  .tg-stat { margin: 0 0 18px; }
  .tg-bar { position: relative; height: 18px; background: var(--panel); border: 1px solid var(--line); cursor: ew-resize; touch-action: none; }
  .tg-bar:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .tg-meas, .tg-proj { position: absolute; top: 0; left: 0; bottom: 0; display: block; }
  .tg-meas { width: var(--w); background: var(--line); }
  .tg-proj { background: var(--gold); opacity: .85; transition: width .35s cubic-bezier(.25,1,.3,1); }
  .tg-rank { margin: 14px 0 10px; border: 1px dashed var(--gold); width: fit-content; padding: 7px 14px; }
  #tg-solve { font: inherit; font-size: 13.5px; padding: 9px 16px; border: 1px solid var(--gold); background: transparent; color: var(--gold); cursor: pointer; letter-spacing: .04em; }
  #tg-solve:disabled { opacity: .5; cursor: default; }
  #tg-solve:hover:not(:disabled) { background: var(--gold); color: var(--bg); }
  .flip { display: inline-block; animation: flip .5s cubic-bezier(.25,1,.3,1); }
  @keyframes flip { from { transform: rotateX(90deg); } }
  .stamp { animation: stamp .45s cubic-bezier(.25,1,.3,1) backwards; }
  @keyframes stamp { from { transform: scale(1.15); opacity: 0; } }
  #confetti { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
  #confetti i { position: absolute; top: -14px; width: 8px; height: 12px; animation: fall 1.6s ease-in forwards; }
  @keyframes fall { to { transform: translateY(105vh) rotate(540deg); opacity: .2; } }
  ul.jutsu li { transition: transform .2s; }
  ul.jutsu li:hover { transform: translateY(-1px); }
  .quests label { cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
  .quests li.done { border-left-color: var(--gold); opacity: .75; }
  .quests .chip { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--gold); border: 1px solid var(--line); padding: 1px 7px; margin-left: 8px; font-weight: 400; }
  .quests .chip.assumed { color: var(--muted); }
  .meter { display: inline-block; width: 90px; height: 6px; background: var(--panel2); border: 1px solid var(--line); vertical-align: middle; margin: 6px 6px 6px 0; }
  .meter i { display: block; height: 100%; width: var(--p); background: var(--accent); }
  .meter-label { font-size: 11.5px; }
  .cmd-line { margin-top: 7px; display: flex; gap: 6px; align-items: center; }
  .cmd-line code { user-select: all; -webkit-user-select: all; border: 1px solid var(--line); padding: 3px 8px; font-size: 12px; background: var(--panel2); color: var(--ink); }
  .cmd-copy { font: inherit; font-size: 11.5px; padding: 3px 9px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; }
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
  @media (prefers-reduced-motion: reduce) {
    .bar i, .stamp, .flip, #confetti i { animation: none; }
    .tg-proj { transition: none; }
    ul.jutsu li { transition: none; }
  }
</style>
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
