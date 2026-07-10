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
  var host = window.parent;               // the trusted host frame (the console Runner)
  var nextId = 1;
  var pending = {};                       // JSON-RPC id -> { resolve, reject } for in-flight tools/call
  var queue = [];                         // tools/call messages built before the handshake is ready
  var subs = {};                          // JSON-RPC method (or "*") -> [cb] for streamed notifications
  var initIds = {};                       // ids used for ui/initialize (each retry gets a fresh one)
  var iv = null;                          // handshake retry interval

  function post(msg) { try { if (host && host !== window) host.postMessage(msg, "*"); } catch (e) { /* sealed / no host */ } }

  var api = {
    ready: false,
    hostTools: [],
    callTool: function (name, args) {
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        var msg = { jsonrpc: "2.0", id: id, method: "tools/call", params: { name: name, arguments: args || {} } };
        pending[id] = { resolve: resolve, reject: reject };
        // Gate on the handshake: posting before the host has attached its listener would lose the
        // call (only ui/initialize retries), and a fixed timeout would break slow user consent (a
        // gated cap can wait on the user clicking Allow for well over 10s). So: not ready yet, queue
        // it (flushed once ui/initialize resolves, below); ready, post now and just wait for the reply
        // however long it takes — if the host is gone the frame is being torn down and the promise
        // dies with it, and if the handshake never completes the retry-exhaustion below rejects it.
        if (api.ready) post(msg); else queue.push(msg);
      });
    },
    onNotification: function (method, cb) { (subs[method] || (subs[method] = [])).push(cb); }
  };
  window.agentgemApp = api;

  window.addEventListener("message", function (e) {
    if (e.source !== host) return;        // only the trusted host frame; nothing else is the boundary
    var d = e.data;
    if (!d || d.jsonrpc !== "2.0") return;
    if (d.id != null && initIds[d.id] && d.result && !api.ready) {  // ui/initialize result
      api.ready = true;
      api.hostTools = d.result.tools || [];
      if (iv) { clearInterval(iv); iv = null; }
      post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
      for (var qi = 0; qi < queue.length; qi++) post(queue[qi]);  // flush anything queued before ready
      queue = [];
      return;
    }
    if (d.id != null && pending[d.id]) {  // a tools/call reply, matched by id
      var p = pending[d.id]; delete pending[d.id];
      if (d.error) p.reject(new Error((d.error && d.error.message) || "tool error"));
      else p.resolve(d.result);
      return;
    }
    if (d.method === "ui/notifications/tool-result" && d.params) {  // a streamed chunk
      var list = (subs[d.method] || []).concat(subs["*"] || []);
      for (var i = 0; i < list.length; i++) { try { list[i]({ toolName: d.params.toolName, chunk: d.params.chunk }); } catch (err) { /* subscriber threw */ } }
      return;
    }
  });

  // Handshake with bounded retry (~5x / 800ms) — defeats the race where the host hasn't attached its
  // message listener yet when the miniapp first loads. Stops early once the initialize result lands.
  var tries = 0;
  function sendInit() { var id = nextId++; initIds[id] = 1; post({ jsonrpc: "2.0", id: id, method: "ui/initialize" }); }
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
