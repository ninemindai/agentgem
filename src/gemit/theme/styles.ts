// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemit/theme/styles.ts

export const STYLES = `
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
`;
