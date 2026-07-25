// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/reportExemplar.ts
//
// An OPT-IN few-shot example for the report render agent (buildReportPrompt injects it only when the
// caller passes exemplar:true; the controller flips that from AGENTGEM_REPORT_EXEMPLAR, default off).
// It teaches COMPOSITION — the editorial structure the brief describes in prose — by showing a finished
// report the agent imitates.
//
// Critically, it is SEAM-CORRECT: every visible number is read from <script id="report-data"> via inline
// JS, never typed into prose. Few-shot teaches by imitation, so an exemplar that baked numbers into text
// would teach the agent to violate the report's anti-hallucination rule. This one demonstrates the rule.
//
// It reuses the house-style tokens/classes from HOUSE_STYLE_BLOCK (injected just above it in the prompt)
// rather than re-declaring them, so it stays compact and reinforces the spine. Pure string, no imports.
// Deliberately contains no backticks or ${…} so it embeds cleanly in the template literal that wraps it.
export const REPORT_EXEMPLAR = `<!doctype html>
<html data-theme="light"><head><meta charset="utf-8" />
<style>
  /* Tokens + partials (.hs-kpis, .hs-table, .hs-bar) come from the house-style block above; report layout only here. */
  .wrap { max-width: 880px; margin: 0 auto; padding: 40px 28px; background: var(--surface); color: var(--ink); font: var(--t-body)/1.6 var(--sans); }
  .eyebrow { font: 500 var(--t-small) var(--mono); text-transform: uppercase; letter-spacing: .08em; opacity: .6; }
  h1 { font: 500 var(--t-display) var(--serif); letter-spacing: -.01em; margin: 8px 0 4px; }
  .lede { opacity: .75; max-width: 640px; margin: 0 0 8px; }
  .hs-bar { margin: 12px 0 24px; }
  .advice { margin: 24px 0 0; padding-left: 18px; }
</style></head>
<body>
  <script type="application/json" id="report-data">
{"scope":"session","when":"Jul 24","sessions":3,"peakStale":42,"findings":7,
 "rows":[{"name":"auth-fix","stale":42,"verdict":"over budget"},
         {"name":"ui-pass","stale":23,"verdict":"watch"},
         {"name":"docs","stale":9,"verdict":"ok"}],
 "advice":["Compact auth-fix before the next turn","Trim stale tool output in ui-pass"]}
  </script>
  <div class="wrap">
    <div class="eyebrow" id="eyebrow"></div>
    <h1 id="thesis"></h1>
    <p class="lede" id="lede"></p>
    <div class="hs-kpis">
      <div class="hs-kpi"><b id="k-sessions"></b><span>sessions</span></div>
      <div class="hs-kpi"><b id="k-stale"></b><span>peak stale</span></div>
      <div class="hs-kpi"><b id="k-findings"></b><span>findings</span></div>
    </div>
    <svg class="hs-bar" id="chart" role="img" aria-label="stale percent by session"></svg>
    <div class="hs-scroll"><table class="hs-table"><thead><tr><th>session</th><th>stale %</th><th>verdict</th></tr></thead><tbody id="rows"></tbody></table></div>
    <ul class="advice" id="advice"></ul>
  </div>
  <script>
    var D = JSON.parse(document.getElementById("report-data").textContent);
    var esc = function (s) { return String(s).replace(/[&<>]/g, function (c) { return ({ "&":"&amp;", "<":"&lt;", ">":"&gt;" })[c]; }); };
    // Every number reaches the page from D — never typed into prose. THIS is the seam to imitate.
    document.getElementById("eyebrow").textContent = "context hygiene \\u00b7 " + D.scope + " \\u00b7 " + D.when;
    document.getElementById("thesis").textContent = D.rows.length + " sessions leaked context past the compaction line.";
    document.getElementById("lede").textContent = "The worst offender held " + D.peakStale + "% of its window in stale tool output.";
    document.getElementById("k-sessions").textContent = D.sessions;
    document.getElementById("k-stale").textContent = D.peakStale + "%";
    document.getElementById("k-findings").textContent = D.findings;
    var max = Math.max.apply(null, D.rows.map(function (r) { return r.stale; })), y = 0, bars = "";
    D.rows.forEach(function (r) {
      var w = Math.max(2, Math.round((r.stale / max) * 430));
      bars += '<rect x="130" y="' + (y + 4) + '" width="' + w + '" height="14" rx="3"></rect>';
      bars += '<text x="0" y="' + (y + 15) + '">' + esc(r.name) + '</text>';
      bars += '<text x="' + (136 + w) + '" y="' + (y + 15) + '">' + r.stale + '</text>';
      y += 22;
    });
    var svg = document.getElementById("chart");
    svg.setAttribute("viewBox", "0 0 620 " + y); svg.innerHTML = bars;
    document.getElementById("rows").innerHTML = D.rows.map(function (r) {
      return "<tr><td>" + esc(r.name) + '</td><td class="hs-num">' + r.stale + "</td><td>" + esc(r.verdict) + "</td></tr>";
    }).join("");
    document.getElementById("advice").innerHTML = D.advice.map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("");
  </script>
</body></html>`;
