// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Sealed HTML scaffolds — runnable starting points the studio agent writes into. Inline everything
// (no external src/href/fetch; data: assets only) so a scaffold passes gameGate before the agent
// touches it. The agent replaces the block between the AGENTGEM:GAME-LOGIC markers. TS string
// constants so they compile into dist (no fs paths).
function sealedTemplate(title: string, subtitle: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  html,body { height:100%; margin:0; background:#0d1117; color:#e8edf4; font:16px/1.4 system-ui, sans-serif; overflow:hidden; }
  #stage { position:fixed; inset:0; display:grid; place-items:center; }
  canvas { max-width:100%; max-height:100%; }
  #hud { position:fixed; top:12px; left:12px; font:600 14px system-ui; opacity:.85; }
</style></head>
<body>
  <div id="hud">${subtitle}</div>
  <div id="stage"><canvas id="c" width="640" height="400"></canvas></div>
  <script>
  (function () {
    "use strict";
    const canvas = document.getElementById("c");
    const ctx = canvas.getContext("2d");
    const dataEl = document.getElementById("game-data");
    const DATA = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
    // ==== AGENTGEM:GAME-LOGIC START ====
    let t = 0;
    function frame() {
      ctx.fillStyle = "#0d1117"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#3b82f6"; ctx.font = "20px system-ui";
      ctx.fillText("${title}", 24, 40 + Math.sin(t / 20) * 4);
      t++; requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    // ==== AGENTGEM:GAME-LOGIC END ====
  })();
  </script>
</body></html>`;
}

// The replay scaffold RENDERS the session out of the box (stats + tool chart + a play/pause scrubbable
// timeline) from the injected game-data, so a freshly-seeded replay is immediately meaningful — the
// studio agent then themes/gamifies the block between the AGENTGEM:GAME-LOGIC markers. Defensive: with
// no data (the bare scaffold the gate runs) it shows an empty state rather than throwing.
function replayScaffold(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Session Replay</title>
<style>
  :root { color-scheme: dark; }
  html,body { height:100%; margin:0; overflow:hidden; color:#e8edf4; font:14px/1.5 system-ui, sans-serif;
    background:radial-gradient(120% 90% at 50% 0%, #16121f, #0b0a12 72%); }
  #wrap { max-width:760px; margin:0 auto; padding:18px; box-sizing:border-box; height:100%; display:flex; flex-direction:column; }
  .wait { display:grid; place-items:center; height:100%; color:#8b98ac; font-size:15px; }
  .title { font:700 18px Georgia, serif; letter-spacing:.5px; text-align:center; }
  .title .sub { display:block; font:600 11px system-ui; letter-spacing:.14em; text-transform:uppercase; color:#8b7bb8; margin-top:3px; }
  .arena { display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:10px; margin:14px 0; }
  .fighter { background:#161225; border:1px solid #2a2340; border-radius:12px; padding:12px; text-align:center; }
  .fighter.hit { animation:shake .3s; }
  .fighter.turn { border-color:#7c5cff; box-shadow:0 0 0 1px #7c5cff, 0 10px 26px -14px #7c5cff; }
  .ava { font-size:40px; line-height:1; filter:drop-shadow(0 4px 10px rgba(0,0,0,.5)); }
  .nm { font:600 14px system-ui; margin:6px 0 8px; } .nm span { display:block; font:600 10px system-ui; text-transform:uppercase; letter-spacing:.1em; color:#8b98ac; }
  .hpbar { height:12px; background:#0c0a14; border:1px solid #2a2340; border-radius:99px; overflow:hidden; }
  .hp { height:100%; width:100%; background:linear-gradient(90deg,#31d07a,#7ee787); transition:width .35s cubic-bezier(.2,.8,.2,1); }
  .hp.low { background:linear-gradient(90deg,#e0533b,#ff8a5c); }
  .hpn { font:600 11px system-ui; color:#cdd6e4; margin-top:5px; font-variant-numeric:tabular-nums; }
  .vs { font:800 15px Georgia, serif; color:#e0533b; text-shadow:0 0 12px rgba(224,83,59,.6); }
  .log { flex:1; overflow:auto; background:#100d1c; border:1px solid #241d38; border-radius:12px; padding:10px 12px; display:flex; flex-direction:column; gap:5px; min-height:70px; }
  .line { font:500 12.5px system-ui; opacity:.92; } .line b { font-weight:700; }
  .line.h { color:#7ee787; } .line.a { color:#a6b0ff; }
  .win { text-align:center; font:800 16px Georgia, serif; min-height:20px; margin:6px 0; }
  .ctl { display:flex; align-items:center; gap:10px; }
  .ctl button { background:#7c5cff; color:#fff; border:0; border-radius:9px; padding:8px 16px; cursor:pointer; font:700 13px system-ui; }
  #scrub { flex:1; accent-color:#7c5cff; } .cnt { font:600 11px system-ui; color:#8b98ac; font-variant-numeric:tabular-nums; }
  @keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-5px)} 75%{transform:translateX(5px)} }
</style></head>
<body>
  <div id="wrap"><div id="app"></div></div>
  <script>
  (function () {
    "use strict";
    const app = document.getElementById("app");
    const fmtDur = (ms) => { const s = Math.max(0, Math.round((ms||0)/1000)); return s<60 ? s+"s" : Math.floor(s/60)+"m "+(s%60)+"s"; };
    const num = (n) => (n||0).toLocaleString();
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;" }[c]));
    let timer = 0;

    // --- host data bridge (boilerplate — keep this) --- the session transcript is host-brokered, not
    // baked into the bundle, so this stays tiny + always fresh. Ask the trusted parent for it; render
    // on the feed. A shared/offline replay (no host) simply shows the waiting state.
    const dataEl = document.getElementById("game-data");
    let DATA = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
    window.addEventListener("message", (e) => {
      if (e.source !== window.parent) return;
      const d = e.data;
      if (d && d.type === "agentgem:feed" && d.channel === "session-data") { DATA = d.data || {}; boot(); }
    });
    function requestData() { try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: "agentgem:request", want: "session-data" }, "*"); } catch (e) {} }

    // ==== AGENTGEM:GAME-LOGIC START ====
    // The coding session, replayed as an RPG DUEL: You (the Human) vs the AI Agent, driven by DATA
    // ({meta, timeline}). User turns are your attacks, assistant turns are the agent's. The studio agent
    // can re-theme this block. (fmtDur/num above are unused by this genre — left for other themings.)
    const HUMAN_ATK = ["Scope Creep","Rubber Duck","Coffee Refill","Stack Overflow","Git Blame","Rage Quit","Hotfix","Requirements Change","Code Review","Deadline Crunch"];
    const AGENT_ATK = ["Refactor","Hallucination","Token Overflow","Context Window","Confident Guess","Infinite Loop","Verbose Reply","Edge Case","Unit Test","Semicolon Fix"];
    let hitTimer = 0;
    function boot() {
      if (timer) { clearInterval(timer); timer = 0; }
      const meta = DATA.meta || {};
      const timeline = Array.isArray(DATA.timeline) ? DATA.timeline : [];
      if (!timeline.length) { app.innerHTML = '<div class="wait">⚔ Waiting for session data…</div>'; return; }
      const model = String(meta.model || "the Agent"), project = String(meta.project || "this session"), maxHP = 120;
      // Precompute the whole battle so play + scrub stay consistent.
      let hHP = maxHP, aHP = maxHP, over = false, winner = "";
      const rounds = [];
      for (let i = 0; i < timeline.length; i++) {
        const t = timeline[i] || {}, human = t.role === "user";
        const atk = (human ? HUMAN_ATK : AGENT_ATK)[i % 10];
        const dmg = 5 + (i % 4) * 3 + ((t.text ? t.text.length : 7) % 10);
        if (!over) { if (human) aHP = Math.max(0, aHP - dmg); else hHP = Math.max(0, hHP - dmg); }
        if (!over && aHP === 0) { over = true; winner = "human"; } else if (!over && hHP === 0) { over = true; winner = "agent"; }
        rounds.push({ human: human, atk: atk, dmg: dmg, hHP: hHP, aHP: aHP, ko: over });
      }
      if (!winner) winner = hHP >= aHP ? "human" : "agent";
      const koIdx = rounds.findIndex((r) => r.ko);
      const lastRound = koIdx >= 0 ? koIdx : rounds.length - 1;

      app.innerHTML =
        '<div class="title">⚔ ' + esc(project) + ' ⚔<span class="sub">session duel · ' + timeline.length + ' moves</span></div>' +
        '<div class="arena">' +
          '<div class="fighter" id="fh"><div class="ava">🧑‍💻</div><div class="nm">You<span>the Human</span></div><div class="hpbar"><div class="hp" id="hph"></div></div><div class="hpn" id="hphn"></div></div>' +
          '<div class="vs">VS</div>' +
          '<div class="fighter" id="fa"><div class="ava">🤖</div><div class="nm">' + esc(model) + '<span>the Agent</span></div><div class="hpbar"><div class="hp" id="hpa"></div></div><div class="hpn" id="hpan"></div></div>' +
        '</div><div class="log" id="log"></div><div class="win" id="win"></div>' +
        '<div class="ctl"><button id="play">▶ Battle</button><input id="scrub" type="range" min="0" max="' + (rounds.length-1) + '" value="0" /><span class="cnt" id="cnt"></span></div>';

      const fh=document.getElementById("fh"), fa=document.getElementById("fa"), hph=document.getElementById("hph"), hpa=document.getElementById("hpa"),
        hphn=document.getElementById("hphn"), hpan=document.getElementById("hpan"), logEl=document.getElementById("log"), winEl=document.getElementById("win"),
        scrub=document.getElementById("scrub"), cnt=document.getElementById("cnt"), playBtn=document.getElementById("play");
      let i = 0, playing = false;
      function show(n) {
        i = Math.max(0, Math.min(n, lastRound));
        const r = rounds[i], pc = (v) => Math.round(v/maxHP*100);
        hph.style.width = pc(r.hHP)+"%"; hpa.style.width = pc(r.aHP)+"%";
        hph.className = "hp" + (r.hHP <= maxHP*0.3 ? " low" : ""); hpa.className = "hp" + (r.aHP <= maxHP*0.3 ? " low" : "");
        hphn.textContent = r.hHP+" / "+maxHP; hpan.textContent = r.aHP+" / "+maxHP;
        fh.className = "fighter" + (r.human ? " turn" : ""); fa.className = "fighter" + (r.human ? "" : " turn");
        const def = r.human ? fa : fh; def.classList.add("hit"); if (hitTimer) clearTimeout(hitTimer); hitTimer = setTimeout(() => def.classList.remove("hit"), 300);
        logEl.innerHTML = rounds.slice(0, i+1).map((x) => '<div class="line ' + (x.human?"h":"a") + '">' + (x.human ? "🧑‍💻 You" : "🤖 " + esc(model)) + ' cast <b>' + esc(x.atk) + '</b> — ' + x.dmg + ' dmg</div>').join("");
        logEl.scrollTop = logEl.scrollHeight;
        scrub.value = String(i); cnt.textContent = (i+1)+" / "+(lastRound+1);
        winEl.textContent = i >= lastRound ? (winner === "human" ? "🏆 You win!" : "🤖 The Agent wins!") : "";
      }
      function stop() { playing = false; playBtn.textContent = "▶ Battle"; if (timer) clearInterval(timer); timer = 0; }
      function play() { if (i >= lastRound) show(0); playing = true; playBtn.textContent = "❚❚ Pause"; timer = setInterval(() => { if (i < lastRound) show(i+1); else stop(); }, 650); }
      playBtn.addEventListener("click", () => (playing ? stop() : play()));
      scrub.addEventListener("input", () => { if (playing) stop(); show(Number(scrub.value)||0); });
      show(0);
    }
    // ==== AGENTGEM:GAME-LOGIC END ====

    boot();
    // Broker-fed: ask the host for the transcript, retrying a few times so a transient miss (or a
    // listener-attach race) still resolves rather than sticking on the waiting state.
    if (!(DATA.timeline && DATA.timeline.length)) {
      requestData();
      let tries = 0;
      const retry = setInterval(() => {
        if ((DATA.timeline && DATA.timeline.length) || ++tries > 5) { clearInterval(retry); return; }
        requestData();
      }, 800);
    }
  })();
  </script>
</body></html>`;
}

const SCAFFOLDS: Record<string, string> = {
  replay: replayScaffold(),
  "skill-run": sealedTemplate("Skill Run", "⚙ practice"),
  "project-fun": sealedTemplate("Project Fun", "★ play"),
};

export function scaffoldFor(scaffoldId: string): string {
  const html = SCAFFOLDS[scaffoldId];
  if (!html) throw new Error(`unknown scaffold '${scaffoldId}'`);
  return html;
}
