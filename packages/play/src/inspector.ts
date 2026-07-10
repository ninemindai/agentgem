// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The Protocol Inspector — a built-in conformance harness, ported from ext-apps' debug-server view. It
// exercises every host capability on purpose (an event log filterable by every callback, a host-info
// dump, a callback-status table, and a button for every method) so it derives all SEVEN capabilities —
// including "session-data", a "content" capability that would demand a baked timeline and full consent
// at saveMiniapp. It is therefore NEVER saved: this module is the only place it is defined, a dev route
// serves it synthetically (play.controller.ts), and it must never be registered in SCAFFOLDS or GENRES.
//
// Word-list trap: gameGate's NETWORK_CALL regex scans the WHOLE document (scannableCode only strips the
// content of inert `type="application/json"` scripts), so "fetch"/"XMLHttpRequest"/"WebSocket"/
// "EventSource"/"importScripts"/"navigator.sendBeacon" must not appear anywhere below — not in markup
// text, not in a comment, not in a string. The live/subscribe capability is labeled "subscribe"/"stream".
import type { GameCapability } from "@agentgem/model";
import { mcpAppClient } from "./mcpAppClient.js";
import type { MiniappMeta } from "./miniapps.js";

export const INSPECTOR_META = {
  name: "__inspector",
  title: "Protocol Inspector",
  genre: "replay",
  createdFrom: { kind: "blank", title: "Protocol Inspector" },
  engineVersion: "2",
  // `as GameCapability[]`, not `as const`: MiniappMeta.needs is the mutable GameCapability[] the rest of
  // the package expects, and `as const` on the enclosing object would freeze this into a readonly tuple
  // that satisfies() then rejects as not assignable to the mutable property type.
  needs: [
    "session-data", "local-project-access", "live-session-events", "invoke-agent",
    "open-link", "send-message", "update-model-context",
  ] as GameCapability[],
  // `satisfies MiniappMeta & { name: string }`: MiniappMeta itself has no `name` field (the registry keys
  // miniapps by name externally) but play.controller.ts's dev route reads INSPECTOR_META.name directly, so
  // the literal needs the extra property named in the intersection or the excess-property check on the
  // fresh object literal rejects it.
} satisfies MiniappMeta & { name: string };

export const INSPECTOR_HTML = `<!doctype html>
<html lang="en"><head>${mcpAppClient()}<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Protocol Inspector</title>
<style>
  :root { color-scheme: light dark; }
  html,body { height:100%; margin:0;
    background: var(--color-background-primary, #0d1117);
    color: var(--color-text-primary, #e8edf4);
    font:13px/1.5 ui-monospace, Menlo, monospace; }
  #wrap { height:100%; box-sizing:border-box; padding:12px; display:flex; flex-direction:column; gap:10px; overflow:hidden; }
  h1 { font:700 15px system-ui, sans-serif; margin:0; }
  section { border:1px solid var(--color-border-primary, #2a2340); border-radius:8px; padding:8px 10px;
    background: var(--color-background-secondary, #161225); }
  section > b { font:700 11px system-ui, sans-serif; text-transform:uppercase; letter-spacing:.08em; opacity:.7; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(210px, 1fr)); gap:6px; margin-top:6px; }
  button { background:#7c5cff; color:#fff; border:0; border-radius:6px; padding:6px 10px; font:600 11px system-ui, sans-serif; cursor:pointer; }
  button:disabled { opacity:.45; cursor:default; }
  table { width:100%; border-collapse:collapse; font:12px ui-monospace, monospace; margin-top:6px; }
  th, td { text-align:left; padding:3px 6px; border-bottom:1px solid var(--color-border-primary, #241d38); }
  #hostinfo-body div { padding:1px 0; word-break:break-all; }
  #logsec { flex:1; display:flex; flex-direction:column; min-height:0; }
  #log { flex:1; overflow:auto; margin-top:6px; }
  .entry { padding:3px 0; border-bottom:1px solid var(--color-border-primary, #241d38); }
  .entry .k { font-weight:700; color:#a6b0ff; }
  .entry pre { white-space:pre-wrap; word-break:break-all; margin:3px 0 0; opacity:.8; }
  select { background:transparent; color:inherit; border:1px solid var(--color-border-primary, #2a2340); border-radius:5px; padding:3px 6px; }
</style></head>
<body>
  <div id="wrap">
    <h1>Protocol Inspector</h1>
    <section><b>Host</b><div id="hostinfo-body">no host bridge yet</div></section>
    <section><b>Callback status</b>
      <table id="status-table"><thead><tr><th>callback</th><th>count</th><th>last</th></tr></thead><tbody></tbody></table>
    </section>
    <section><b>Fire a method</b><div class="grid" id="btns"></div></section>
    <section id="logsec">
      <div style="display:flex; align-items:center; gap:8px;">
        <b>Event log</b>
        <select id="filter"><option value="">all</option></select>
      </div>
      <div id="log"></div>
    </section>
  </div>
  <script id="game-data" type="application/json">{"meta":{"project":"protocol-inspector-demo","model":"demo"},"timeline":[{"role":"user","tsMs":0,"text":"Inspect every capability."},{"role":"assistant","tsMs":1200,"text":"Every callback and method below is wired and logged."}]}</script>
  <script>
  (function () {
    "use strict";
    var dataEl = document.getElementById("game-data");
    var DATA = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
    var app = window.agentgemApp;

    var logEl = document.getElementById("log");
    var filterEl = document.getElementById("filter");
    var statusBody = document.querySelector("#status-table tbody");
    var hostInfoBody = document.getElementById("hostinfo-body");
    var btns = document.getElementById("btns");

    var esc = function (s) { return String(s).replace(/[&<>]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]; }); };
    var nowStr = function () { return new Date().toISOString().slice(11, 23); };

    // ==== AGENTGEM:GAME-LOGIC START ====
    // Every callback the host may push, tracked with a fire count + the timestamp of the last one.
    var CALLBACKS = [
      "ui/notifications/tool-result", "ui/notifications/tool-input",
      "ui/notifications/tool-cancelled", "ui/notifications/host-context-changed",
    ];
    var counts = {}, lastAt = {};
    CALLBACKS.forEach(function (c) { counts[c] = 0; lastAt[c] = ""; });

    function renderStatus() {
      statusBody.innerHTML = CALLBACKS.map(function (c) {
        return "<tr><td>" + esc(c) + "</td><td>" + counts[c] + "</td><td>" + esc(lastAt[c] || "—") + "</td></tr>";
      }).join("");
    }

    var entries = [];
    function addFilterOption(kind) {
      if (filterEl.querySelector('option[value="' + kind + '"]')) return;
      var o = document.createElement("option"); o.value = kind; o.textContent = kind; filterEl.appendChild(o);
    }
    function renderLog() {
      var f = filterEl.value;
      var shown = f ? entries.filter(function (e) { return e.kind === f; }) : entries;
      logEl.innerHTML = shown.slice(-300).map(function (e) {
        return '<div class="entry"><span class="k">' + esc(e.kind) + "</span> · " + e.ts +
          "<pre>" + esc(JSON.stringify(e.payload)) + "</pre></div>";
      }).join("");
      logEl.scrollTop = logEl.scrollHeight;
    }
    function log(kind, payload) {
      entries.push({ kind: kind, ts: nowStr(), payload: payload });
      addFilterOption(kind);
      renderLog();
    }
    filterEl.addEventListener("change", renderLog);
    CALLBACKS.forEach(addFilterOption);
    renderStatus();

    // A small styles sample — the CSS variables the host may push (hostStyles.ts's MCP_UI_STYLE_KEYS).
    var STYLE_KEYS = ["--color-background-primary", "--color-background-secondary", "--color-text-primary", "--color-border-primary"];
    function renderHostInfo() {
      var ctx = (app && app.hostContext) || {};
      var styles = {};
      STYLE_KEYS.forEach(function (k) { styles[k] = getComputedStyle(document.documentElement).getPropertyValue(k); });
      hostInfoBody.innerHTML =
        "<div>ready: " + esc(String(app ? app.ready : false)) + "</div>" +
        "<div>hostTools: " + esc(JSON.stringify((app && app.hostTools) || [])) + "</div>" +
        "<div>containerDimensions: " + esc(JSON.stringify(ctx.containerDimensions || {})) + "</div>" +
        "<div>hostContext: " + esc(JSON.stringify(ctx)) + "</div>" +
        "<div>styles sample: " + esc(JSON.stringify(styles)) + "</div>";
    }
    renderHostInfo();

    // Subscribe to every notification the shim dispatches, before the first frame — the host may push
    // tool-input/tool-result immediately after the handshake (see MINIAPP_BUILDER_BRIEF).
    if (app) {
      CALLBACKS.forEach(function (c) {
        app.onNotification(c, function (payload) {
          counts[c]++; lastAt[c] = nowStr();
          renderStatus(); renderHostInfo();
          log(c, payload);
        });
      });
    }

    // One button per capability. All FOUR host tool names as literals (via callTool), and all THREE
    // action methods as literal window.agentgemApp.method(...) calls — that literal spelling is what
    // deriveNeeds() reads back out of this document (an aliased reference would scan as nothing, see
    // capabilityScan.ts). Every result — success OR error — is logged: send-message/update-model-context
    // are external-chat-host-only, so our own console host replies with a JSON-RPC -32601 for them, and
    // logging that reply (rather than swallowing it) is exactly the inspector's job.
    // requestDisplayMode buttons below exercise the shim's method too, but display-mode isn't a
    // GameCapability (no entry in TOOL_CAP/capabilityScan.ts), so they don't add an 8th need.
    function fireButton(label, kind, run) {
      var b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", function () {
        b.disabled = true;
        run().then(
          function (result) { log(kind, { ok: true, result: result }); },
          function (err) { log(kind, { ok: false, error: (err && err.message) || String(err) }); }
        ).then(function () { b.disabled = false; });
      });
      btns.appendChild(b);
    }

    if (app) {
      fireButton("callTool: agentgem_get_session_data", "call:agentgem_get_session_data",
        function () { return window.agentgemApp.callTool("agentgem_get_session_data"); });
      fireButton("callTool: agentgem_get_inventory", "call:agentgem_get_inventory",
        function () { return window.agentgemApp.callTool("agentgem_get_inventory"); });
      fireButton("callTool: agentgem_subscribe_sessions (stream)", "call:agentgem_subscribe_sessions",
        function () { return window.agentgemApp.callTool("agentgem_subscribe_sessions"); });
      fireButton("callTool: agentgem_invoke_agent", "call:agentgem_invoke_agent",
        function () { return window.agentgemApp.callTool("agentgem_invoke_agent"); });
      fireButton("openLink", "action:open-link",
        function () { return window.agentgemApp.openLink("https://modelcontextprotocol.io/"); });
      fireButton("sendMessage", "action:send-message",
        function () { return window.agentgemApp.sendMessage({ role: "user", content: "protocol inspector ping" }); });
      fireButton("updateModelContext", "action:update-model-context",
        function () { return window.agentgemApp.updateModelContext({ structuredContent: { source: "protocol-inspector", turns: (DATA.timeline || []).length } }); });
      fireButton("requestDisplayMode: fullscreen", "action:request-display-mode-fullscreen",
        function () { return window.agentgemApp.requestDisplayMode("fullscreen"); });
      fireButton("requestDisplayMode: inline", "action:request-display-mode-inline",
        function () { return window.agentgemApp.requestDisplayMode("inline"); });
    } else {
      hostInfoBody.textContent = "no host bridge present (window.agentgemApp is undefined)";
    }
    // ==== AGENTGEM:GAME-LOGIC END ====
  })();
  </script>
</body></html>`;
