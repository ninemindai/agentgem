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
  html,body { height:100%; margin:0; background:#0d1117; color:#e8edf4; font:14px/1.5 system-ui, sans-serif; }
  #wrap { max-width:900px; margin:0 auto; padding:20px; box-sizing:border-box; }
  h1 { font-size:20px; margin:0 0 2px; } .sub { color:#8b98ac; font-size:12px; margin-bottom:16px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:16px; }
  .tile { background:#161d29; border:1px solid #232c3b; border-radius:10px; padding:10px 12px; }
  .tile b { font-size:20px; display:block; font-variant-numeric:tabular-nums; } .tile span { color:#8b98ac; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
  .tools { margin-bottom:16px; } .toolrow { display:flex; align-items:center; gap:8px; margin:3px 0; }
  .toolrow .n { width:120px; font-size:12px; color:#cdd6e4; } .toolrow .bar { height:12px; background:#3b82f6; border-radius:3px; min-width:2px; }
  .toolrow .c { font-size:11px; color:#8b98ac; }
  #stage { background:#161d29; border:1px solid #232c3b; border-radius:10px; padding:16px; min-height:120px; }
  #stage .role { font:600 12px system-ui; text-transform:uppercase; letter-spacing:.1em; }
  #stage .role.user { color:#10b981; } #stage .role.assistant { color:#818cf8; }
  #stage .text { margin-top:8px; white-space:pre-wrap; }
  #controls { display:flex; align-items:center; gap:12px; margin-top:12px; }
  #controls button { background:#3b82f6; color:#fff; border:0; border-radius:8px; padding:8px 14px; cursor:pointer; font:600 14px system-ui; }
  #scrub { flex:1; } #count { color:#8b98ac; font-size:12px; font-variant-numeric:tabular-nums; }
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
    // A real, playable session replay from DATA ({meta, timeline}). The studio agent enhances this.
    function boot() {
      if (timer) { clearInterval(timer); timer = 0; }
      const meta = DATA.meta || {};
      const timeline = Array.isArray(DATA.timeline) ? DATA.timeline : [];
      if (!timeline.length) { app.innerHTML = '<h1>Session Replay</h1><div class="sub">Waiting for session data…</div>'; return; }
      const tools = meta.tools || {};
      const toolEntries = Object.keys(tools).map((k) => [k, tools[k]]).sort((a,b) => b[1]-a[1]);
      const maxTool = toolEntries.reduce((m,e) => Math.max(m, e[1]), 1);
      const tile = (v, l) => '<div class="tile"><b>' + v + '</b><span>' + l + '</span></div>';
      app.innerHTML =
        '<h1>' + esc(meta.project || "Session Replay") + '</h1>' +
        '<div class="sub">' + [meta.model, meta.gitBranch, fmtDur((meta.endMs||0)-(meta.startMs||0))].filter(Boolean).map(esc).join(" · ") + '</div>' +
        '<div class="tiles">' + tile(num(meta.msgs || timeline.length), "messages") + tile(num(meta.tokensIn), "tokens in") + tile(num(meta.tokensOut), "tokens out") + tile(num(toolEntries.length), "tool kinds") + '</div>' +
        (toolEntries.length ? '<div class="tools">' + toolEntries.map((e) => '<div class="toolrow"><span class="n">' + esc(e[0]) + '</span><span class="bar" style="width:' + Math.round(e[1]/maxTool*260) + 'px"></span><span class="c">' + e[1] + '</span></div>').join("") + '</div>' : '') +
        '<div id="stage"></div>' +
        '<div id="controls"><button id="play">▶ Play</button><input id="scrub" type="range" min="0" max="' + Math.max(0, timeline.length-1) + '" value="0" /><span id="count"></span></div>';
      const stage = document.getElementById("stage"), scrub = document.getElementById("scrub"), count = document.getElementById("count"), playBtn = document.getElementById("play");
      let i = 0, playing = false;
      function render() {
        const t = timeline[i] || {};
        stage.innerHTML = '<div class="role ' + (t.role === "user" ? "user" : "assistant") + '">' + esc(t.role || "assistant") + '</div><div class="text">' + (t.text ? esc(t.text) : "…") + '</div>';
        scrub.value = String(i); count.textContent = (i+1) + " / " + timeline.length;
      }
      function stop() { playing = false; playBtn.textContent = "▶ Play"; if (timer) clearInterval(timer); timer = 0; }
      function play() { playing = true; playBtn.textContent = "❚❚ Pause"; timer = setInterval(() => { if (i < timeline.length - 1) { i++; render(); } else stop(); }, 700); }
      playBtn.addEventListener("click", () => (playing ? stop() : play()));
      scrub.addEventListener("input", () => { i = Number(scrub.value) || 0; if (playing) stop(); render(); });
      render();
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
