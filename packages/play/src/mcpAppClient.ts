// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The embedded client shim a sealed miniapp loads to talk MCP Apps `ui/*` JSON-RPC to the trusted host
// (the console Runner's `mcpUiHost` router). This is the standard-wire successor to the old private
// postMessage bridge baked into scaffolds.ts (`agentgem:request` / `agentgem:feed`): a miniapp still boots
// on its baked DATA first (host-independent, see the scaffold), but now speaks `ui/initialize` +
// `tools/call` + `ui/notifications/tool-result`. Like the old bridge it RETRIES the handshake a bounded
// few times to defeat the host listener-attach race — a single-shot initialize would stick a freshly
// mounted miniapp on its waiting state. Returned as a <script> string injected into the miniapp document;
// this module is pure/string-only (no I/O, no DOM here).

import { hostStyleScript } from "./hostStyles.js";

// A detectable substring carried inside the emitted <script>. A migration that swaps the old bridge for
// this shim greps for it to stay idempotent (don't inject twice).
export const MCP_CLIENT_MARKER = "agentgem:mcp-app-client:2";
// Matches any shim version so the on-read backstop can replace an older one wholesale.
export const MCP_CLIENT_MARKER_RE = /agentgem:mcp-app-client(?::\d+)?/;

export function mcpAppClient(): string {
  return `<script>
// ${MCP_CLIENT_MARKER}
(function () {
  "use strict";
${hostStyleScript()}
  var host = window.parent;               // the trusted host frame (the console Runner)
  var nextId = 1;
  var pending = {};                       // JSON-RPC id -> { resolve, reject } for in-flight tools/call
  var queue = [];                         // tools/call messages built before the handshake is ready
  var subs = {};                          // JSON-RPC method (or "*") -> [cb] for streamed notifications
  var initIds = {};                       // ids used for ui/initialize (each retry gets a fresh one)
  var iv = null;                          // handshake retry interval

  function post(msg) { try { if (host && host !== window) host.postMessage(msg, "*"); } catch (e) { /* sealed / no host */ } }

  // Shared REQUEST plumbing behind callTool + the three action methods: allocate an id, park its
  // resolve/reject, and gate the post on the handshake exactly the way callTool always has (queue
  // pre-ready, post-and-wait once ready — see the comment on the queue gate below).
  function sendRequest(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      var msg = { jsonrpc: "2.0", id: id, method: method, params: params };
      pending[id] = { resolve: resolve, reject: reject };
      // Gate on the handshake: posting before the host has attached its listener would lose the
      // call (only ui/initialize retries), and a fixed timeout would break slow user consent (a
      // gated cap can wait on the user clicking Allow for well over 10s). So: not ready yet, queue
      // it (flushed once ui/initialize resolves, below); ready, post now and just wait for the reply
      // however long it takes — if the host is gone the frame is being torn down and the promise
      // dies with it, and if the handshake never completes the retry-exhaustion below rejects it.
      if (api.ready) post(msg); else queue.push(msg);
    });
  }

  var api = {
    ready: false,
    hostTools: [],
    hostContext: {},
    callTool: function (name, args) {
      return sendRequest("tools/call", { name: name, arguments: args || {} });
    },
    // The three action caps (open-link real console semantics; send-message/update-model-context are
    // external-chat-host-only — our console host replies -32601 for those, see mcpUiHost.ts). All three
    // reuse sendRequest, so a call before handshake queues and the host's reply resolves/rejects it,
    // exactly like callTool.
    openLink: function (url) { return sendRequest("ui/open-link", { url: url }); },
    sendMessage: function (params) { return sendRequest("ui/message", params); },
    updateModelContext: function (params) { return sendRequest("ui/update-model-context", params); },
    // copy-command: host writes the text to the OS clipboard (consent-gated, shows the text, never
    // remembered -- mirrors open-link's posture). Resolves on copy, rejects on deny/unsupported.
    copyCommand: function (text) { return sendRequest("ui/copy-command", { text: text }); },
    // Resolves to the host's reply { mode }: the mode the host ACTUALLY applied, not necessarily the
    // one requested — the host may refuse (e.g. a thumbnail always refuses fullscreen), see mcpUiHost.ts.
    requestDisplayMode: function (mode) { return sendRequest("ui/request-display-mode", { mode: mode }); },
    onNotification: function (method, cb) { (subs[method] || (subs[method] = [])).push(cb); },
    // MCP connectors (spec §4). Mirrors window.claude.mcp: callTool RESOLVES with {payload, content}
    // on success and THROWS an McpError-shaped {code, message} on failure, so a claude.ai artifact ports
    // nearly verbatim. The host router (mcpUiHost) replies with the server ENVELOPE as the JSON-RPC
    // result (never a JSON-RPC error), so the structured code survives the generic resolve path above;
    // this wrapper converts {ok:false, error} into the throw. listTools returns the host's
    // consent-gated {servers:[{server, tools, status}]} verbatim (no digest is ever sent here).
    mcp: {
      callTool: function (server, tool, input) {
        return sendRequest("mcp/call", { server: server, tool: tool, input: input }).then(function (r) {
          if (r && r.ok) return { payload: r.payload, content: r.content };
          var msg = (r && r.error && r.error.message) || "connector call failed";
          var err = new Error(msg);
          err.code = (r && r.error && r.error.code) || "upstream_error";
          throw err;
        });
      },
      listTools: function () { return sendRequest("mcp/list", {}); }
    }
  };
  window.agentgemApp = api;

  function dispatch(method, payload) {
    var list = (subs[method] || []).concat(subs["*"] || []);
    for (var i = 0; i < list.length; i++) { try { list[i](payload); } catch (err) { /* subscriber threw */ } }
  }

  function applyHostContext(ctx) {
    if (!ctx) return;
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles && ctx.styles.variables) applyHostStyleVariables(ctx.styles.variables);
  }

  // Reports our rendered size to the host only when the host hasn't already fixed our container
  // (containerDimensions with both width AND height set — the Runner does this). Reporting on top of a
  // host-fixed size would fight the host's own layout.
  function maybeObserveSize(ctx) {
    var cd = (ctx && ctx.containerDimensions) || {};
    if (cd.width != null && cd.height != null) return;       // host fixed our size — do not report
    if (typeof ResizeObserver === "undefined") return;
    var report = function () {
      var h = document.documentElement.scrollHeight, w = window.innerWidth;
      post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: w, height: h } });
    };
    try { new ResizeObserver(report).observe(document.documentElement); report(); } catch (e) { /* no-op */ }
  }

  window.addEventListener("message", function (e) {
    if (e.source !== host) return;        // only the trusted host frame; nothing else is the boundary
    var d = e.data;
    if (!d || d.jsonrpc !== "2.0") return;
    if (d.id != null && initIds[d.id] && d.result && !api.ready) {  // ui/initialize result
      api.ready = true;
      var hostMeta = (d.result._meta || {})["ai.agentgem/host"] || {};
      api.hostTools = hostMeta.tools || [];                          // granted tools ride _meta now, not result.tools
      api.hostContext = d.result.hostContext || {};
      if (api.hostContext) applyHostContext(api.hostContext);
      maybeObserveSize(api.hostContext);
      if (iv) { clearInterval(iv); iv = null; }
      post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
      for (var qi = 0; qi < queue.length; qi++) post(queue[qi]);  // flush anything queued before ready
      queue = [];
      return;
    }
    if (d.method == null && d.id != null && pending[d.id]) {  // a tools/call reply: responses never carry a method
      var p = pending[d.id]; delete pending[d.id];
      if (d.error) p.reject(new Error((d.error && d.error.message) || "tool error"));
      else p.resolve(d.result);
      return;
    }
    if (d.method === "ui/notifications/tool-result" && d.params) {   // spec: params IS a CallToolResult
      var s = (d.params._meta || {})["ai.agentgem/stream"] || {};
      var evt = { toolName: s.toolName, chunk: d.params.structuredContent };  // FROZEN shape the games expect
      dispatch("ui/notifications/tool-result", evt);
      return;
    }
    if (d.method === "ui/notifications/tool-input" && d.params) {    // launcher args (host->app)
      dispatch("ui/notifications/tool-input", d.params.arguments || {});
      return;
    }
    if (d.method === "ui/notifications/tool-cancelled") { dispatch("ui/notifications/tool-cancelled", d.params || {}); return; }
    if (d.method === "ui/notifications/host-context-changed" && d.params) {
      api.hostContext = Object.assign(api.hostContext || {}, d.params);
      applyHostContext(d.params);
      dispatch("ui/notifications/host-context-changed", d.params);
      return;
    }
    if (d.method === "ui/resource-teardown") {                       // REQUEST — must reply
      var res = {};
      try { dispatch("ui/resource-teardown", d.params || {}); } catch (err) { /* handler threw */ }
      post({ jsonrpc: "2.0", id: d.id, result: res });
      return;
    }
  });

  // Handshake with bounded retry (~5x / 800ms) — defeats the race where the host hasn't attached its
  // message listener yet when the miniapp first loads. Stops early once the initialize result lands.
  var tries = 0;
  function sendInit() {
    var id = nextId++; initIds[id] = 1;
    post({ jsonrpc: "2.0", id: id, method: "ui/initialize", params: {
      appInfo: { name: "agentgem-miniapp", version: "2" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      protocolVersion: "2026-01-26",
    }});
  }
  sendInit();
  iv = setInterval(function () {
    if (api.ready || ++tries > 5) {
      if (!api.ready) {  // handshake exhausted: no host present — reject rather than leak the pending calls
        for (var pid in pending) { if (Object.prototype.hasOwnProperty.call(pending, pid)) pending[pid].reject(new Error("no host")); }
        pending = {};
        queue = [];
      }
      clearInterval(iv); iv = null;
      return;
    }
    sendInit();
  }, 800);
})();
</script>`;
}
