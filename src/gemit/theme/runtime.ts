// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemit/theme/runtime.ts

// Page runtime: wires sliders/quests/confetti to the revived sim functions. Kept as a
// plain string (not serialized TS) because it touches the DOM. Count-up + bar-fill mean
// early screenshots show low numbers — same pre-delay caveat as the PR-1 stat bars.
export const RUNTIME_JS = `(function () {
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

  // "Measured" is documented as read-only — the bars only become draggable once
  // #disciplines is in .whatif. isWhatIf() is the single choke point every user-triggered
  // mutation path (drag, keyboard, quest checkbox) checks before touching vals/DOM, so
  // none of them can move the displayed numbers, flip a tier, or fire confetti while the
  // mode readout still says "measured".
  //
  // TWO paths may ENTER what-if: the toggle button, and ticking a quest. A quest tick IS
  // the what-if gesture ("what if I did this?"), so blocking it and silently reverting the
  // box read as a broken checkbox rather than a gated one — the box has no disabled state
  // and no cursor change to say otherwise. It now enters the mode instead. The read-only
  // invariant is preserved because setWhatIf(true) flips the readout BEFORE the delta is
  // applied: numbers still never move while the page says "measured".
  //
  // setAxis() is left ungated, since the toggle-off reset and the auto-solve tween both
  // call it legitimately from *inside* an already-whatif (or just-left-whatif) transition.
  var sect = document.getElementById("disciplines");
  var wi = document.querySelector(".wi");
  function isWhatIf() { return !!sect && sect.classList.contains("whatif"); }

  function setWhatIf(on) {
    if (!wi || !sect) return;
    wi.setAttribute("aria-pressed", on ? "true" : "false");
    sect.classList.toggle("whatif", on);
    document.getElementById("disc-mode").textContent = on ? "projected" : "measured";
    document.querySelector(".tg-rank").hidden = !on;
    document.getElementById("tg-solve").hidden = !on;
    if (!on) { setAxis("ctx", meas.ctx); setAxis("proc", meas.proc); setAxis("setup", meas.setup);
      Array.prototype.forEach.call(document.querySelectorAll(".quests input[type=checkbox]"), function (cb) {
        cb.checked = false; cb.closest("li").classList.remove("done");
      });
    }
  }

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
    var box = document.querySelector('.disc[data-axis="' + axis + '"]');
    if (!box) return;
    box.querySelector(".tg-val").textContent = String(v);
    var bar = box.querySelector(".track");
    bar.setAttribute("aria-valuenow", String(v));
    bar.querySelector(".tg-proj").style.width = v + "%";
    recompute();
  }

  Array.prototype.forEach.call(document.querySelectorAll(".disc"), function (box) {
    var axis = box.getAttribute("data-axis");
    var bar = box.querySelector(".track");
    var dragging = false;
    var fromEvent = function (e) {
      var r = bar.getBoundingClientRect();
      setAxis(axis, 100 * (e.clientX - r.left) / r.width);
    };
    bar.addEventListener("pointerdown", function (e) {
      if (!isWhatIf()) return;
      dragging = true;
      if (bar.setPointerCapture) bar.setPointerCapture(e.pointerId);
      fromEvent(e); e.preventDefault();
    });
    bar.addEventListener("pointermove", function (e) { if (dragging) fromEvent(e); });
    bar.addEventListener("pointerup", function () { dragging = false; });
    bar.addEventListener("pointercancel", function () { dragging = false; });
    bar.addEventListener("keydown", function (e) {
      if (!isWhatIf()) return;
      var step = e.shiftKey ? 5 : 1;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") { setAxis(axis, vals[axis] + step); e.preventDefault(); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { setAxis(axis, vals[axis] - step); e.preventDefault(); }
    });
  });

  // The <label> only wraps the title line — roughly a 24px strip of a ~130px row — so a
  // click anywhere else (the remedy text, the meter, the padding) hit nothing at all.
  // Forward the whole row to the checkbox, minus the parts that own their clicks: the
  // label already toggles natively (forwarding it too would double-toggle straight back),
  // and the copy button and <code> must copy/select a command without ticking the quest.
  Array.prototype.forEach.call(document.querySelectorAll(".quests li"), function (li) {
    li.addEventListener("click", function (e) {
      if (e.target.closest("label, button, code, a")) return;
      var box = li.querySelector("input[type=checkbox]");
      if (!box) return;
      box.checked = !box.checked;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll(".quests input[type=checkbox]"), function (cb) {
    cb.addEventListener("change", function () {
      // Ticking a quest while measured ENTERS what-if rather than reverting the box.
      // The mode readout flips first, so the delta below is never applied under a
      // "measured" label — the projection stays honestly labelled either way.
      if (!isWhatIf()) setWhatIf(true);
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

  if (wi && sect) wi.addEventListener("click", function () {
    setWhatIf(wi.getAttribute("aria-pressed") !== "true");
  });
})();`;
