// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// REPO PULSE — a built-in miniapp: a GitHub dashboard (open PRs / recently merged / recent commits)
// that demos MCP connectors. Served as a CONSTANT (never written to the registry), like EMBER: listed
// in /api/play/miniapps so it shows as an Arcade card, special-cased by name in the read route AND in
// the mcp/call + mcp/servers manifest checks (packages/app/src/play.controller.ts) — a built-in has no
// registry entry for readMiniapp() to find, so its connector manifest comes from this META.
//
// It is the first mcpNeeds-only built-in: no classic `needs` at all. The host attaches the mcp router
// when mcpNeeds is non-empty (Runner), and every call is consent-gated + manifest-checked server-side.
// With no host, or no "github" connector installed, it renders its no-connector state — the spec's
// public-artifact parity (hosted players never install agentgemApp.mcp).
//
// Author constraints (this is emitted verbatim as the miniapp document):
//   * The inner <script> uses NO backticks and NO ${...} — those would be captured by THIS template
//     literal. Only ${mcpAppClient()} in <head> is interpolated here. String concatenation only.
//   * gameGate's network-word regex scans the WHOLE document, comments and strings included, so the
//     banned network words must not appear anywhere below. Say "load", never the HTTP verb-word.
//   * Every connector call is the full literal window.agentgemApp.mcp.callTool("github", "<tool>") —
//     deriveMcpNeeds only sees that form (aliases derive nothing), and the gate test pins
//     derived === declared. Tools in META are sorted because the scanner sorts.
import type { McpNeed } from "@agentgem/model";
import { mcpAppClient } from "./mcpAppClient.js";
import type { MiniappMeta } from "./miniapps.js";

export const REPO_PULSE_META = {
  name: "__repo-pulse",
  title: "Repo Pulse",
  genre: "project-fun",
  createdFrom: { kind: "blank", title: "Repo Pulse" },
  engineVersion: "1",
  mcpNeeds: [
    { server: "github", tools: ["list_commits", "list_pull_requests", "search_pull_requests"] },
  ] as McpNeed[],
} satisfies MiniappMeta & { name: string };

export const REPO_PULSE_HTML = `<!doctype html>
<html lang="en"><head>${mcpAppClient()}<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Repo Pulse — your repo's heartbeat</title>
<style>
  :root{--bg:#0b0d12;--panel:#12151d;--line:#222736;--ink:#e8eaf2;--dim:#8b93a7;
    --pr:#37e6a0;--merged:#b48cff;--commit:#5ab8ff;--warn:#ffb44d;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;overflow:hidden}
  body{background:var(--color-background-primary,var(--bg));color:var(--color-text-primary,var(--ink));
    font-family:var(--mono);display:flex;flex-direction:column}
  header{display:flex;gap:10px;align-items:center;padding:14px 18px;
    border-bottom:1px solid var(--color-border-primary,var(--line));flex-wrap:wrap}
  h1{font-size:14px;letter-spacing:.28em;margin:0;color:var(--pr)}
  #repo{flex:1;min-width:180px;background:var(--color-background-secondary,var(--panel));
    border:1px solid var(--color-border-primary,var(--line));border-radius:6px;color:inherit;
    font:inherit;padding:7px 10px}
  #go{background:var(--pr);border:0;border-radius:6px;color:#04281a;font:inherit;font-weight:700;
    padding:7px 16px;cursor:pointer}
  #go:disabled{opacity:.5;cursor:default}
  #status{padding:6px 18px;font-size:11px;color:var(--dim);min-height:24px}
  main{flex:1;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;
    padding:0 18px 18px;overflow:auto}
  section{background:var(--color-background-secondary,var(--panel));
    border:1px solid var(--color-border-primary,var(--line));border-radius:10px;padding:12px;min-height:120px}
  section h2{font-size:10px;letter-spacing:.2em;margin:0 0 10px;color:var(--dim)}
  section.open h2{color:var(--pr)} section.merged h2{color:var(--merged)} section.commits h2{color:var(--commit)}
  ul{list-style:none;margin:0;padding:0;font-size:12px}
  li{padding:6px 0;border-bottom:1px solid var(--color-border-primary,var(--line));
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  li:last-child{border-bottom:0}
  li b{color:var(--ink);font-weight:600} li span{color:var(--dim)}
  .empty{color:var(--dim);font-size:12px}
  #fallback{display:none;flex:1;align-items:center;justify-content:center;text-align:center;
    padding:24px;color:var(--dim);font-size:13px;line-height:1.7}
  #fallback b{color:var(--warn)}
</style></head>
<body>
<header>
  <h1>REPO PULSE</h1>
  <input id="repo" placeholder="owner/repo  (e.g. ninemindai/agentgem)" spellcheck="false" />
  <button id="go" type="button">LOAD</button>
</header>
<div id="status">Boots from your GitHub connector. Nothing here is stored or sent anywhere else.</div>
<main id="board">
  <section class="open"><h2>OPEN PULL REQUESTS</h2><ul id="open-list"><li class="empty">—</li></ul></section>
  <section class="merged"><h2>RECENTLY MERGED</h2><ul id="merged-list"><li class="empty">—</li></ul></section>
  <section class="commits"><h2>RECENT COMMITS</h2><ul id="commit-list"><li class="empty">—</li></ul></section>
</main>
<div id="fallback" class="no-connector">
  <div><b>No GitHub connector.</b><br />
  Repo Pulse reads open PRs, merges and commits through the host's
  <b>github</b> MCP server. Install one (any GitHub MCP server named
  "github"), then reopen this card.<br />
  On the public marketplace this state is expected: sealed games get no connectors.</div>
</div>
<script>
(function () {
  var el = function (id) { return document.getElementById(id); };
  var statusEl = el("status"), board = el("board"), fallback = el("fallback");
  var busy = false;

  function setStatus(t) { statusEl.textContent = t; }
  function row(main, sub) {
    var li = document.createElement("li");
    var b = document.createElement("b"); b.textContent = main;
    var s = document.createElement("span"); s.textContent = sub ? "  " + sub : "";
    li.appendChild(b); li.appendChild(s); return li;
  }
  function fill(id, rows, emptyMsg) {
    var ul = el(id); ul.textContent = "";
    if (!rows.length) {
      var li = document.createElement("li"); li.className = "empty"; li.textContent = emptyMsg;
      ul.appendChild(li); return;
    }
    for (var i = 0; i < Math.min(rows.length, 8); i++) ul.appendChild(rows[i]);
  }
  // The connector's reply: prefer the derived payload, fall back to parsing the first text content.
  function unwrap(res) {
    if (res && res.payload != null) return res.payload;
    try {
      var c = res && res.content && res.content[0];
      if (c && c.type === "text") return JSON.parse(c.text);
    } catch (e) { /* fall through */ }
    return null;
  }
  function asList(p) {
    if (Array.isArray(p)) return p;
    if (p && Array.isArray(p.items)) return p.items;
    return [];
  }
  function parseRepo(v) {
    var m = /^\\s*([\\w.-]+)\\/([\\w.-]+)\\s*$/.exec(v || "");
    return m ? { owner: m[1], repo: m[2] } : null;
  }

  function loadAll() {
    var target = parseRepo(el("repo").value);
    if (!target) { setStatus("Enter a repo as owner/repo."); return; }
    if (busy) return;
    busy = true; el("go").disabled = true; setStatus("Loading " + target.owner + "/" + target.repo + " …");
    var done = 0, failed = null;
    var settle = function () {
      done++;
      if (done === 3) {
        busy = false; el("go").disabled = false;
        setStatus(failed ? "Partial load: " + failed : "Live from your github connector. Reload any time.");
      }
    };
    window.agentgemApp.mcp.callTool("github", "list_pull_requests", { owner: target.owner, repo: target.repo, state: "open" })
      .then(function (res) {
        fill("open-list", asList(unwrap(res)).map(function (p) {
          return row("#" + p.number + " " + (p.title || ""), p.user && p.user.login);
        }), "no open PRs");
      })
      .catch(function (e) { failed = String(e && e.message || e); fill("open-list", [], "unavailable"); })
      .then(settle);
    window.agentgemApp.mcp.callTool("github", "search_pull_requests", {
      query: "repo:" + target.owner + "/" + target.repo + " is:pr is:merged", perPage: 8,
    })
      .then(function (res) {
        fill("merged-list", asList(unwrap(res)).map(function (p) {
          return row("#" + p.number + " " + (p.title || ""), p.user && p.user.login);
        }), "none found");
      })
      .catch(function (e) { failed = String(e && e.message || e); fill("merged-list", [], "unavailable"); })
      .then(settle);
    window.agentgemApp.mcp.callTool("github", "list_commits", { owner: target.owner, repo: target.repo, perPage: 8 })
      .then(function (res) {
        fill("commit-list", asList(unwrap(res)).map(function (c) {
          var msg = (c.commit && c.commit.message || "").split("\\n")[0];
          var who = c.commit && c.commit.author && c.commit.author.name;
          return row((c.sha || "").slice(0, 7) + " " + msg, who);
        }), "none found");
      })
      .catch(function (e) { failed = String(e && e.message || e); fill("commit-list", [], "unavailable"); })
      .then(settle);
  }

  el("go").addEventListener("click", loadAll);
  el("repo").addEventListener("keydown", function (e) { if (e.key === "Enter") loadAll(); });

  // Boot: paint the idle dashboard immediately; never block first paint on a host. The shim retries
  // the handshake over roughly four seconds, so probe briefly for the mcp member before declaring
  // no-connector.
  var tries = 0;
  var probe = setInterval(function () {
    tries++;
    if (window.agentgemApp && window.agentgemApp.mcp) {
      clearInterval(probe);
      setStatus("Connected. Enter owner/repo and press LOAD.");
      el("repo").focus();
    } else if (tries > 25) {
      clearInterval(probe);
      board.style.display = "none";
      statusEl.style.display = "none";
      fallback.style.display = "flex";
    }
  }, 200);
})();
</script>
</body></html>
`;
