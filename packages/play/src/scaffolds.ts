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

const SCAFFOLDS: Record<string, string> = {
  replay: sealedTemplate("Session Replay", "▶ replay"),
  "skill-run": sealedTemplate("Skill Run", "⚙ practice"),
  "project-fun": sealedTemplate("Project Fun", "★ play"),
};

export function scaffoldFor(scaffoldId: string): string {
  const html = SCAFFOLDS[scaffoldId];
  if (!html) throw new Error(`unknown scaffold '${scaffoldId}'`);
  return html;
}
