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
  .disc { margin: 0 0 16px; }
  .disc-head { display: flex; justify-content: space-between; align-items: baseline; }
  .disc-head b { font-size: 15.5px; font-weight: normal; }
  .disc-head span { font-size: 17px; }
  .track { height: 9px; margin-top: 7px; border-radius: 5px; background: var(--panel); border: 1px solid var(--line); overflow: hidden; position: relative; }
  .track:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .track{ cursor:default; }
  #disciplines.whatif .track{ cursor:ew-resize; touch-action:none; }
  .tg-meas, .tg-proj { position: absolute; top: 0; left: 0; bottom: 0; display: block; border-radius: 5px; }
  .tg-meas { width: var(--w); background: var(--line); }
  #disciplines:not(.whatif) .tg-meas{ display:none; }
  .tg-proj { background: var(--gold); opacity: .85; animation: grow 1s cubic-bezier(.25,1,.3,1) var(--d) backwards; transition: width .35s cubic-bezier(.25,1,.3,1); }
  .disc.low .tg-proj { background: var(--accent); opacity: 1; }
  .wi{ flex:none; order:2; align-self:center; font-family: ui-monospace, Menlo, monospace; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; padding: 4px 11px; border-radius: 99px; cursor: pointer; border: 1px solid var(--line); background: transparent; color: inherit; opacity: .75; }
  .wi[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; opacity: 1; }
  h2::after{ order:1; }
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
    .tg-proj, .stamp, .flip, #confetti i { animation: none; }
    .tg-proj { transition: none; }
    ul.jutsu li { transition: none; }
  }

  /* ============ THE CARD — fixed dark treatment, identical in both themes ======= */
  /* Type/spacing scale the ported card rules below need, matching @agentgem/model's
     HOUSE_TOKENS values verbatim ahead of the full house-token adoption (a later task
     imports HOUSE_TOKENS directly and this block goes away). */
  :root {
    --serif: ui-serif, Georgia, "Times New Roman", serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --t-body: 14px; --t-small: 11px;
    --sp-1: 6px; --sp-2: 12px; --sp-3: 18px; --sp-4: 30px;
    --radius: 8px;
  }
  .card{ --plate:#16181d; background:var(--plate); color:#ece7dc; border-radius:var(--radius);
    padding:var(--sp-4) var(--sp-4) var(--sp-3); position:relative; overflow:hidden;
    border:1px solid rgba(236,231,220,.09);
    box-shadow:inset 0 1px 0 rgba(255,244,216,.10),0 1px 2px rgba(0,0,0,.28),0 12px 32px -12px rgba(0,0,0,.45); }
  :root[data-theme="dark"] .card{ --plate:#20242c; border-color:rgba(236,231,220,.16);
    box-shadow:inset 0 1px 0 rgba(255,244,216,.14),0 0 0 1px rgba(0,0,0,.5),0 16px 40px -16px rgba(0,0,0,.8); }
  @media (prefers-color-scheme: dark) {
    /* No explicit [data-theme="dark"] set: give system-dark visitors the same lifted
       plate, unless they've explicitly opted into the light attribute. */
    :root:not([data-theme="light"]) .card{ --plate:#20242c; border-color:rgba(236,231,220,.16);
      box-shadow:inset 0 1px 0 rgba(255,244,216,.14),0 0 0 1px rgba(0,0,0,.5),0 16px 40px -16px rgba(0,0,0,.8); }
  }
  .card::before{content:"";position:absolute;inset:0;
    background:radial-gradient(120% 90% at 82% -10%, rgba(201,100,66,.20), transparent 62%);
    pointer-events:none}
  /* text-align and color must be set explicitly here — the bare .eyebrow rule (used by the
     untouched doorway) still matches this element too and would otherwise win with its own
     center alignment and muted grey, since .card .eyebrow leaves them unset. */
  .card .eyebrow{font:500 var(--t-small)/1.4 var(--mono);letter-spacing:.2em;
    text-transform:uppercase;color:inherit;text-align:left;opacity:.62;margin:0 0 var(--sp-3)}
  .crown{display:flex;gap:var(--sp-4);align-items:center}
  .ring{flex:0 0 132px;position:relative;width:132px;height:132px}
  .ring svg{width:132px;height:132px;transform:rotate(-90deg);display:block}
  .ring .trk{fill:none;stroke:rgba(236,231,220,.14);stroke-width:9}
  .ring .arc{fill:none;stroke:#d9a441;stroke-width:9;stroke-linecap:round;
    stroke-dasharray:339.3;stroke-dashoffset:71.3;
    animation:sweep 1.1s cubic-bezier(.25,1,.3,1) .2s backwards}
  @keyframes sweep{from{stroke-dashoffset:339.3}}
  .ring .num{position:absolute;inset:0;display:grid;place-content:center;text-align:center}
  /* color:inherit outranks the pre-existing base .count{color:var(--accent)} rule (0,2,1
     specificity beats 0,1,0) — .count stays on the element for the runtime's count-up hook,
     but the ring's headline number must read in the card's ink, not the low-pip warning red. */
  .ring .num b{display:block;font:600 42px/1 var(--mono);letter-spacing:-.02em;color:inherit}
  .ring .num span{display:block;font:500 10px/1 var(--mono);letter-spacing:.16em;
    opacity:.5;margin-top:5px}
  .crown-txt{min-width:0}
  /* color: FIRST and standalone — if the gradient fails to paint, text-fill-color
     transparent would render the title invisible rather than merely unstyled. */
  .tier{ font:600 clamp(38px,8vw,var(--tier-max,60px))/.95 var(--serif); letter-spacing:.02em;
    text-transform:uppercase; color:#e8c87d; margin:0;
    background-image:linear-gradient(96deg,#e8c87d 30%,#fff4d8 46%,#e8c87d 62%);
    -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent;
    background-size:220% 100%; animation:shine 2.4s cubic-bezier(.4,0,.2,1) .5s 1 both; }
  @keyframes shine{from{background-position:150% 0}to{background-position:-40% 0}}
  .flavor{font:italic var(--t-body)/1.5 var(--serif);opacity:.66;margin:var(--sp-1) 0 0}
  .hook{display:inline-block;margin:var(--sp-3) 0 0;padding:5px 12px;border-radius:99px;
    background:rgba(217,164,65,.13);border:1px solid rgba(217,164,65,.34);
    color:#e8c87d;font:600 12px/1.4 var(--mono);letter-spacing:.05em;text-transform:uppercase}
  .cohort{margin:var(--sp-2) 0 0;font:500 var(--t-small)/1.5 var(--mono);
    letter-spacing:.08em;text-transform:uppercase;opacity:.58}
  .cohort b{color:#e8c87d;opacity:1}
  .pips{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--sp-3);
    margin:var(--sp-4) 0 0;padding-top:var(--sp-3);border-top:1px solid rgba(236,231,220,.13)}
  .pip span{display:block;font:500 10px/1.4 var(--mono);letter-spacing:.14em;
    text-transform:uppercase;opacity:.55}
  .pip b{display:block;font:600 21px/1.2 var(--mono);margin:3px 0 5px}
  .pip i{display:block;height:4px;border-radius:2px;background:rgba(236,231,220,.14)}
  .pip i::after{content:"";display:block;height:100%;border-radius:2px;background:#d9a441;
    width:var(--w);animation:grow 1s cubic-bezier(.25,1,.3,1) var(--d) backwards}
  .pip.low i::after{background:var(--accent)}
  @keyframes grow{from{width:0}}
  .strip{display:flex;justify-content:space-between;align-items:center;gap:var(--sp-2);
    margin:var(--sp-3) 0 0;padding-top:var(--sp-2);border-top:1px solid rgba(236,231,220,.13);
    font:500 var(--t-small)/1.5 var(--mono);letter-spacing:.1em;text-transform:uppercase;opacity:.62}
  .gems{color:#e8c87d;opacity:.92;letter-spacing:.24em}

  /* ============ SEAM ============ */
  .seam{display:flex;align-items:center;gap:var(--sp-2);margin:var(--sp-4) 0 var(--sp-4)}
  .seam::before,.seam::after{content:"";height:1px;background:var(--line);flex:1}
  .seam span{font:500 var(--t-small) var(--mono);letter-spacing:.2em;
    text-transform:uppercase;opacity:.45}
`;
