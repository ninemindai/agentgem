// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// EMBER — a built-in miniapp: a flame that grows and smokes as the viewer's LIVE session context window
// fills toward its cap. Served as a CONSTANT (never written to the registry), like the Protocol Inspector,
// but LISTED so it shows as an Arcade card (src/play.controller.ts injects it + special-cases it by name).
//
// It is the playful face of the Watch tab's clinical HygieneNudge: both read the server-computed
// context-hygiene stream. EMBER declares `needs: ["context-hygiene"]`; the console host brokers that cap
// by opening /api/watch/hygiene for the most-recent session and pushing each { verdict, cap, curveTail }
// event in. The gauge is curveTail.at(-1).ctxTokens / cap. With no live session (or no host, e.g.
// app.agentgem.ai), it runs a self-contained demo simulation — its baked, portable fallback.
//
// Author constraints (this is emitted verbatim as the miniapp document):
//   * The inner <script> uses NO backticks and NO ${...} — those would be captured by THIS template
//     literal. Only ${mcpAppClient()} in <head> is interpolated here.
//   * Canvas 2D calls no-op when getContext returns null (jsdom has no canvas), so the DOM-only game
//     logic (gauge/mood/score) stays testable.
import type { GameCapability } from "@agentgem/model";
import { mcpAppClient } from "./mcpAppClient.js";
import type { MiniappMeta } from "./miniapps.js";

export const EMBER_META = {
  name: "__ember",
  title: "Ember",
  genre: "session-heatmap",
  createdFrom: { kind: "blank", title: "Ember" },
  engineVersion: "1",
  // `as GameCapability[]` (not `as const`): MiniappMeta.needs is a mutable GameCapability[]; a readonly
  // tuple from `as const` would fail the `satisfies` assignability check (mirrors inspector.ts).
  needs: ["context-hygiene", "copy-command"] as GameCapability[],
} satisfies MiniappMeta & { name: string };

export const EMBER_HTML = `<!doctype html>
<html lang="en"><head>${mcpAppClient()}<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>EMBER — bank the session before it burns out</title>
<style>
  :root{
    --bg:#0a0a0d; --panel:#111116; --panel-2:#16161d; --line:#24242e;
    --ash:#8b8b98; --dim:#5a5a67; --ink:#f2efe9;
    --fresh:#37e6d4; --ember:#ff7a1a; --hot:#ffd23f; --smoke:#ff3d3d; --gold:#ffcf4d;
    --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{background:radial-gradient(120% 90% at 50% 8%,#15120e 0%,var(--bg) 55%);
    color:var(--ink);font-family:var(--mono);overflow:hidden;user-select:none;
    -webkit-font-smoothing:antialiased}
  .stage{height:100%;max-width:860px;margin:0 auto;display:grid;
    grid-template-rows:auto 1fr auto;padding:16px clamp(12px,3vw,26px) 18px}
  .hud{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
  .brand{font-size:15px;letter-spacing:.34em;font-weight:700;color:var(--ember);
    text-shadow:0 0 18px rgba(255,122,26,.5)}
  .brand small{display:block;letter-spacing:.12em;font-size:9.5px;color:var(--dim);margin-top:4px}
  .stats{display:flex;gap:18px;text-align:right}
  .stat .v{font-size:19px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1}
  .stat .k{font-size:9px;letter-spacing:.16em;color:var(--dim);margin-top:4px}
  .stat .v.streak{color:var(--gold)} .stat .v.score{color:var(--fresh)}
  .arena{position:relative;display:flex;align-items:center;justify-content:center}
  canvas#flame{position:absolute;inset:0;width:100%;height:100%}
  .demo-badge{position:absolute;top:12px;left:14px;font-size:9px;letter-spacing:.22em;
    color:var(--dim);border:1px solid var(--line);border-radius:6px;padding:3px 8px;z-index:8;
    background:rgba(17,17,22,.7)}
  .gauge-wrap{position:absolute;left:50%;bottom:6%;transform:translateX(-50%);
    width:min(430px,86%);z-index:3}
  .gLabels{display:flex;justify-content:space-between;font-size:9.5px;letter-spacing:.12em;
    color:var(--dim);margin-bottom:5px}
  .gauge{position:relative;height:16px;border:1px solid var(--line);border-radius:9px;
    background:var(--panel);overflow:hidden}
  .sweet{position:absolute;top:0;bottom:0;background:rgba(55,230,212,.16);
    border-left:1px solid rgba(55,230,212,.5);border-right:1px solid rgba(55,230,212,.5)}
  .fill{position:absolute;top:0;bottom:0;left:0;width:0%;border-radius:9px 0 0 9px;
    background:linear-gradient(90deg,var(--fresh),var(--ember) 62%,var(--smoke));
    transition:width .5s linear}
  .capTick{position:absolute;right:0;top:-4px;bottom:-4px;width:2px;background:var(--smoke);opacity:.7}
  .center-read{position:absolute;top:9%;left:0;right:0;text-align:center;z-index:3;pointer-events:none}
  .mood{font-size:13px;color:var(--ash);letter-spacing:.06em;min-height:18px}
  .ctxnum{font-size:12px;color:var(--dim);margin-top:4px;font-variant-numeric:tabular-nums}
  .toast{position:absolute;top:34%;left:50%;transform:translate(-50%,-6px);z-index:6;
    padding:11px 18px;border:1px solid var(--line);border-radius:11px;background:rgba(17,17,22,.92);
    font-size:13px;letter-spacing:.03em;text-align:center;opacity:0;transition:opacity .35s,transform .35s;
    pointer-events:none;max-width:80%}
  .toast.show{opacity:1;transform:translate(-50%,0)}
  .toast b{color:var(--hot)}
  .combo{position:absolute;top:44%;left:50%;transform:translateX(-50%) scale(.6);z-index:7;
    font-size:34px;font-weight:800;letter-spacing:.06em;opacity:0;pointer-events:none;
    text-shadow:0 0 24px currentColor}
  .combo.pop{animation:pop 1.1s ease-out}
  @keyframes pop{0%{opacity:0;transform:translateX(-50%) scale(.5)}
    18%{opacity:1;transform:translateX(-50%) scale(1.12)}
    70%{opacity:1;transform:translateX(-50%) scale(1)}100%{opacity:0;transform:translateX(-50%) scale(1) translateY(-30px)}}
  .controls{display:flex;gap:12px;align-items:stretch}
  button{font-family:var(--mono);cursor:pointer;border-radius:12px;border:1px solid var(--line);
    font-size:13px;letter-spacing:.06em;padding:15px 18px;transition:transform .08s,box-shadow .2s,background .2s;color:var(--ink)}
  button:active{transform:translateY(1px)}
  .bank{flex:2;background:linear-gradient(180deg,#1c2b28,#12211f);border-color:#2a5b53;
    color:var(--fresh);font-weight:700;box-shadow:0 0 0 rgba(55,230,212,0)}
  .bank.ready{box-shadow:0 0 26px rgba(55,230,212,.35);border-color:var(--fresh)}
  .bank .sub{display:block;font-size:9.5px;letter-spacing:.14em;color:var(--dim);margin-top:5px;font-weight:400}
  .keep{flex:1;background:var(--panel);color:var(--ash)}
  .keep:hover{background:var(--panel-2)}
  .keep.tempt{color:var(--smoke);border-color:#502024}
  .keep .sub{display:block;font-size:9.5px;letter-spacing:.1em;color:var(--dim);margin-top:5px}
  :focus-visible{outline:2px solid var(--fresh);outline-offset:2px}
  .foot{grid-row:3;margin-top:12px;font-size:10px;color:var(--dim);letter-spacing:.05em;text-align:center;line-height:1.5}
  .foot b{color:var(--ash)}
  @media(max-width:520px){.stats{gap:12px}.stat .v{font-size:16px}}
  @media(prefers-reduced-motion:reduce){.fill{transition:none}.combo.pop{animation:none}}
</style></head>
<body>
  <div class="stage">
    <div class="hud">
      <div class="brand">E M B E R<small>bank it before it burns</small></div>
      <div class="stats">
        <div class="stat"><div class="v" id="freshV">100</div><div class="k">FRESHNESS</div></div>
        <div class="stat"><div class="v streak" id="streakV">0</div><div class="k">STREAK</div></div>
        <div class="stat"><div class="v score" id="scoreV">0</div><div class="k">SCORE</div></div>
      </div>
    </div>
    <div class="arena">
      <canvas id="flame"></canvas>
      <div class="demo-badge" id="demoBadge">DEMO</div>
      <div class="center-read">
        <div class="mood" id="mood">a fresh, lean flame. get some work done.</div>
        <div class="ctxnum" id="ctx">context 12k / 1.0M · turn 0</div>
      </div>
      <div class="toast" id="toast"></div>
      <div class="combo" id="combo"></div>
      <div class="gauge-wrap">
        <div class="gLabels"><span>CONTEXT WINDOW</span><span id="capLbl">1.0M CAP</span></div>
        <div class="gauge"><div class="sweet" id="sweet"></div><div class="fill" id="fill"></div><div class="capTick"></div></div>
      </div>
    </div>
    <div class="controls">
      <button class="bank" id="bank">◈ BANK &amp; START FRESH<span class="sub" id="bankSub">extract your work · reset the window</span></button>
      <button class="keep" id="keep">keep going…<span class="sub">one more thing</span></button>
    </div>
    <div class="foot">
      live session flame · the gauge tracks your real context window via the <b>Watch hygiene feed</b>.
      the whole point: <b>stopping is the high score.</b>
    </div>
  </div>
  <script>
  var app = window.agentgemApp;
  var live = false;                 // flips true on the first real hygiene event
  var CAP = 1000000;                // replaced by the streamed cap in live mode
  var SWEET_LO = 0.14, SWEET_HI = 0.32, NUDGE_MID = 0.52, NUDGE_HOT = 0.78; // fractions of CAP
  function sweetLo(){ return SWEET_LO * CAP; }
  function sweetHi(){ return SWEET_HI * CAP; }
  var $ = function(id){ return document.getElementById(id); };
  var fmt = function(n){ return n>=1e6 ? (n/1e6).toFixed(1)+'M' : n>=1e3 ? Math.round(n/1e3)+'k' : (''+Math.round(n)); };
  var cv = $('flame'), ctx = cv.getContext('2d');   // null under jsdom -> render() no-ops
  var W, H, dpr;
  function size(){ dpr = Math.min(2, window.devicePixelRatio || 1); var r = cv.getBoundingClientRect();
    W = r.width; H = r.height; cv.width = W*dpr; cv.height = H*dpr; if(ctx) ctx.setTransform(dpr,0,0,dpr,0,0); }
  window.addEventListener('resize', size); size();

  var g;
  function fresh(){ return { context:12000, turn:0, work:0, freshness:100, switches:0, burned:false }; }
  var state = { score:0, streak:0, best:0 };
  try { state.best = parseInt(localStorage.getItem('agentgem:ember:best') || '0', 10) || 0; } catch(e){}
  function persistBest(){ try { localStorage.setItem('agentgem:ember:best', ''+state.best); } catch(e){} }
  g = fresh();

  function layoutSweet(){ var gw = $('sweet').parentElement.clientWidth;
    $('sweet').style.left = (SWEET_LO*gw)+'px';
    $('sweet').style.width = ((SWEET_HI-SWEET_LO)*gw)+'px'; }
  layoutSweet(); window.addEventListener('resize', layoutSweet);

  function stress(){ return Math.min(1, g.context/CAP); }
  function inSweet(){ return g.context>=sweetLo() && g.context<=sweetHi(); }
  function pastSweet(){ return g.context>sweetHi(); }

  var MOODS = [
    [0.14,'a fresh, lean flame. get some work done.'],
    [0.32,'burning clean and productive — this is the sweet spot.'],
    [0.55,'getting heavy. it re-reads itself every turn now.'],
    [0.78,'smoky. answers wandering, retries creeping in.'],
    [0.95,'choking on its own history. bank it. now.'],
    [1.01,'pinned at the cap. every turn costs a fortune.'] ];
  function mood(){ var s = stress(); for(var i=0;i<MOODS.length;i++){ if(s<MOODS[i][0]) return MOODS[i][1]; } return MOODS[MOODS.length-1][1]; }

  var toastT;
  // toast(): the html arg is ALWAYS a hardcoded literal below (with <b> markup). Stream-provided text goes
  // through toastText() instead, so untrusted content never reaches innerHTML.
  function banner(ms){ var el = $('toast'); el.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function(){ el.classList.remove('show'); }, ms || 2600); }
  function toast(html, ms){ $('toast').innerHTML = html; banner(ms); }
  function toastText(text, ms){ $('toast').textContent = text; banner(ms); }
  function combo(txt, color){ var el = $('combo'); el.textContent = txt; el.style.color = color;
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }

  var nudge = { sweet:false, mid:false, hot:false };
  function resetNudges(){ nudge = { sweet:false, mid:false, hot:false }; }
  function checkNudges(){
    if(!nudge.sweet && g.context>=sweetLo()){ nudge.sweet=true; toast('🟢 <b>sweet spot.</b> real progress, lean window. good time to bank.'); }
    if(!nudge.mid && g.context>=NUDGE_MID*CAP){ nudge.mid=true; toast('🟠 <b>halfway to the cap.</b> is this still the same task?'); }
    if(!nudge.hot && g.context>=NUDGE_HOT*CAP){ nudge.hot=true; toast('🔴 <b>the window is dragging.</b> quality is bleeding — cut it.'); }
  }

  // demo loop — self-simulates a session, but ONLY while not live.
  var last = 0, acc = 0; var TICK = 1200;
  function loop(now){ requestAnimationFrame(loop); if(!last) last = now; var dt = now-last; last = now; render(dt);
    if(live || g.burned) return; acc += dt; while(acc>=TICK){ acc -= TICK; turn(); } }
  function turn(){
    g.turn++;
    var grow = 9000 + g.turn*260 + Math.random()*6000;
    if(Math.random()<0.14){ g.switches++; grow += 70000; g.freshness -= 9;
      toast('⤨ <b>task switch</b> detected — you pulled in a whole new area. +70k, freshness −9.', 2200); }
    g.context = Math.min(CAP, g.context+grow);
    g.work += Math.max(2, 22*(1-stress()*0.85));
    g.freshness = Math.max(0, g.freshness-(1.2+stress()*4));
    checkNudges();
    if(g.context>=CAP){ burnout(); }
    syncHUD();
  }
  function syncHUD(){
    $('freshV').textContent = Math.round(g.freshness);
    $('freshV').style.color = g.freshness>60 ? 'var(--fresh)' : g.freshness>30 ? 'var(--hot)' : 'var(--smoke)';
    $('streakV').textContent = state.streak;
    $('scoreV').textContent = state.score.toLocaleString();
    $('ctx').textContent = 'context '+fmt(g.context)+' / '+fmt(CAP)+' · turn '+g.turn+' · '+g.switches+' switch'+(g.switches!==1?'es':'');
    $('mood').textContent = g.burned ? '✖ burnout. the flame went out.' : mood();
    $('fill').style.width = (g.context/CAP*100)+'%';
    $('capLbl').textContent = fmt(CAP)+' CAP';
    var bank = $('bank');
    bank.classList.toggle('ready', g.work>30 && !pastSweet() && !g.burned);
    $('bankSub').textContent = g.work<20 ? 'do a little work first…' : inSweet() ? 'CLEAN CUT available — bank now' : pastSweet() ? 'still bankable, but the combo is gone' : 'extract your work · reset the window';
    $('keep').classList.toggle('tempt', pastSweet() && !g.burned);
  }
  function bankIt(){
    if(g.burned) return;
    if(live){
      // Honest live gauge: BANK scores the DECISION and nudges /compact, but does NOT reset — the flame
      // only cools when the user actually compacts and the next hygiene event shows fewer ctxTokens.
      if(g.work<8){ toast('nothing banked yet — do a little work first.'); return; }
      var cleanL = inSweet();
      state.streak++;
      var gainL = Math.max(1, Math.round(g.freshness*(cleanL?2:1)*(1+state.streak*0.12)));
      state.score += gainL; state.best = Math.max(state.best, state.score); persistBest();
      combo((cleanL?'CLEAN CUT ':'bank ')+'· /compact', cleanL?'var(--fresh)':'var(--ash)');
      // On a clean cut, hand the user /compact frictionlessly: the host copies it to the clipboard (read
      // window.agentgemApp fresh so a test/host that attaches late is still seen). Fall back to the plain
      // advisory toast when the copy is denied or the cap is unsupported.
      var api = window.agentgemApp;
      if(cleanL && api && typeof api.copyCommand==='function'){
        api.copyCommand('/compact').then(function(){
          toast('🟢 <b>clean cut.</b> copied <b>/compact</b> — paste it into your session.');
        }, function(){
          toast('🟢 <b>clean cut.</b> run <b>/compact</b> now — the flame cools when the real window resets.');
        });
      } else {
        toast(cleanL ? '🟢 <b>clean cut.</b> run <b>/compact</b> now — the flame cools when the real window resets.' : 'run <b>/compact</b> to bank and reset the window.');
      }
      syncHUD(); return;
    }
    if(g.work<8){ toast('nothing to bank yet — get some work done first.'); return; }
    var clean = inSweet(), early = g.context<sweetLo();
    var base = Math.round(g.work*(g.freshness/100));
    var mult = 1, label = '', color = 'var(--fresh)';
    if(clean){ mult=2; label='CLEAN CUT ×2'; color='var(--fresh)'; state.streak++; }
    else if(early){ mult=1; label='banked early'; color='var(--ash)'; state.streak++; }
    else { mult = 1-Math.min(0.6,(g.context-sweetHi())/CAP); label='late bank'; color='var(--hot)'; state.streak++; }
    var gain = Math.max(1, Math.round(base*mult*(1+state.streak*0.12)));
    state.score += gain; state.best = Math.max(state.best, state.score); persistBest();
    combo('+'+gain+'  '+label, color);
    toast(clean ? '✦ <b>clean cut.</b> banked '+base+' work at '+Math.round(g.freshness)+'% freshness, ×2 combo, streak '+state.streak+'.' : 'banked +'+gain+'. '+(early?'a touch early — no work wasted though.':'you let it drift past the sweet spot.')+' streak '+state.streak+'.');
    puff(clean);
    g = fresh(); resetNudges(); syncHUD();
  }
  function keepGoing(){
    if(g.burned || live) return;
    for(var i=0;i<3 && !g.burned;i++) turn();
    if(pastSweet()) toast('…and the window got heavier. sessions like this never end.', 2200);
  }
  function burnout(){
    g.burned = true;
    combo('BURNOUT', '#ff3d3d');
    toast('✖ <b>burnout.</b> the window pinned the cap with '+Math.round(g.work)+' unbanked work. streak reset. tap BANK to start fresh.', 4200);
    state.streak = 0; syncHUD();
  }
  $('bank').onclick = function(){ if(g.burned){ g=fresh(); resetNudges(); toast('🌱 fresh flame. go again.'); syncHUD(); } else bankIt(); };
  $('keep').onclick = keepGoing;
  window.addEventListener('keydown', function(e){ if(e.code==='Space'){ e.preventDefault(); $('bank').click(); }
    if(e.key==='k') keepGoing(); });

  // ---- live wiring: map one hygiene event onto game state ----
  function applyHygiene(evt){
    if(!evt) return;
    if(evt.type==='nudge'){ if(evt.advice) toastText(String(evt.advice).slice(0,160)); return; }
    var tail = evt.curveTail || [];
    var lastP = tail[tail.length-1];
    if(!lastP) return;
    if(typeof evt.cap==='number' && evt.cap>0) CAP = evt.cap;
    if(!live){ live = true; g = fresh(); resetNudges(); var db = $('demoBadge'); if(db) db.style.display = 'none'; }
    g.context = lastP.ctxTokens;
    g.turn = lastP.turn;
    g.freshness = Math.max(0, Math.round(100*(1 - Math.min(1, g.context/CAP))));
    g.work = Math.max(g.work, 12);   // real progress exists; enough to make BANK live
    layoutSweet(); checkNudges(); syncHUD();
  }
  window.__emberFeed = applyHygiene;   // test + no-host seam
  if(app){
    // The shim's FROZEN envelope: notifications dispatch under "ui/notifications/tool-result" as
    // { toolName, chunk } (see mcpAppClient.ts) — never under the tool name itself. Registering on
    // the tool name silently receives nothing and the game stays in DEMO forever.
    app.onNotification('ui/notifications/tool-result', function(p){
      if(p && p.toolName==='agentgem_subscribe_hygiene') applyHygiene(p.chunk);
    });
    app.callTool('agentgem_subscribe_hygiene').catch(function(){ /* idle/denied -> stays demo */ });
  }

  // ---- flame render (canvas particles); no-ops when there is no 2D context ----
  var parts = [];
  function render(dt){
    if(!ctx) return;
    ctx.clearRect(0,0,W,H);
    var cx = W/2, base = H*0.72, s = stress();
    var col = function(a){
      if(g.burned) return 'rgba(90,90,100,'+a+')';
      if(s<0.3){ var k=s/0.3; return 'rgba('+(55+120*k)+','+(230-60*k)+','+(212-120*k)+','+a+')'; }
      if(s<0.7){ var k2=(s-0.3)/0.4; return 'rgba(255,'+(210-90*k2)+','+(60-40*k2)+','+a+')'; }
      var k3=(s-0.7)/0.3; return 'rgba(255,'+(120-90*k3)+','+(20+10*k3)+','+a+')';
    };
    var rate = g.burned ? 1 : 3+Math.round(s*5);
    for(var i=0;i<rate;i++){
      var spread = 14+s*40;
      parts.push({ x:cx+(Math.random()-.5)*spread, y:base, vx:(Math.random()-.5)*(0.3+s*1.2),
        vy:-(1.1+Math.random()*1.4+s*1.1), life:1, r:6+Math.random()*10+s*8, smoke:g.burned||Math.random()<s*0.5 });
    }
    ctx.globalCompositeOperation = 'lighter';
    parts.forEach(function(p){
      p.x+=p.vx; p.y+=p.vy; p.vy*=0.985; p.life-=0.012+0.01*s;
      var a = Math.max(0,p.life)*(p.smoke?0.10:0.5);
      var gr = ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.r*(1.6-p.life*0.5));
      if(p.smoke){ gr.addColorStop(0,'rgba(70,66,72,'+a+')'); gr.addColorStop(1,'rgba(70,66,72,0)'); }
      else { gr.addColorStop(0,col(a)); gr.addColorStop(1,col(0)); }
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(p.x,p.y,p.r*(1.5-p.life*0.4),0,7); ctx.fill();
    });
    ctx.globalCompositeOperation = 'source-over';
    parts = parts.filter(function(p){ return p.life>0 && p.y>-20; });
    var bed = ctx.createRadialGradient(cx,base,2,cx,base,60+s*40);
    bed.addColorStop(0,col(0.5)); bed.addColorStop(1,col(0));
    ctx.fillStyle = bed; ctx.beginPath(); ctx.ellipse(cx,base,60+s*30,14,0,0,7); ctx.fill();
  }
  function puff(clean){
    var cx = W/2, base = H*0.72;
    for(var i=0;i<60;i++){ var ang = Math.random()*7, sp = 1+Math.random()*4;
      parts.push({ x:cx, y:base-20, vx:Math.cos(ang)*sp, vy:-Math.abs(Math.sin(ang)*sp)-1,
        life:1, r:5+Math.random()*8, smoke:!clean&&Math.random()<0.4 }); }
  }
  requestAnimationFrame(loop);
  syncHUD();
  </script>
</body></html>`;
