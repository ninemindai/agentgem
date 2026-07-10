// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Codemod for stored miniapps: bring any bundle up to the standard MCP Apps client shim
// (`mcpAppClient()` in mcpAppClient.ts). Two paths reach it — rewriting the old private postMessage
// bridge (`agentgem:request` / `agentgem:feed`, once baked by `replayScaffold()` in scaffolds.ts), and
// injecting the shim into a bundle that calls `window.agentgemApp` but never had one. Never throws — a
// bundle that talks to no host is reported "unrecognized" rather than blown up; the caller (the
// storage-layer route) decides what that means for its flow.
import { MCP_CLIENT_MARKER, MCP_CLIENT_MARKER_RE, mcpAppClient } from "./mcpAppClient.js";

export type MigrateOutcome = "migrated" | "already" | "unrecognized";

// The old bridge, verbatim from replayScaffold(): a `window.addEventListener("message", ...)` that
// switches on `d.type === "agentgem:feed"`, ending at its own closing `});`. Non-greedy so the first
// `});` after the marker substring — the listener's own close — terminates the match rather than some
// later, unrelated one.
const FEED_LISTENER_RE = /window\.addEventListener\("message",[\s\S]*?agentgem:feed[\s\S]*?\}\);/;

// The old `requestData()` companion, which posts `{ type: "agentgem:request", ... }` to the parent.
// The scaffold defines it on a single line; match through to that line's end so reformatting elsewhere
// in the file doesn't matter.
const REQUEST_DATA_RE = /function requestData\(\)[\s\S]*?agentgem:request[\s\S]*?\n/;

// Replacement bodies exactly per the migration contract: `requestData` stays defined (so the scaffold's
// bottom retry loop, which still calls it, remains harmless — the shim itself does the bounded
// `ui/initialize` retry), and the feed listener becomes a one-shot subscribe to the shim's
// `ui/notifications/tool-result` stream. `DATA`/`boot` resolve in the surrounding game IIFE's scope.
const NEW_FEED_LISTENER =
  'if (window.agentgemApp) window.agentgemApp.onNotification("ui/notifications/tool-result", function (p) { if (p && p.toolName === "agentgem_get_session_data") { DATA = p.chunk || {}; boot(); } });';
const NEW_REQUEST_DATA =
  'function requestData() { if (window.agentgemApp) window.agentgemApp.callTool("agentgem_get_session_data").then(function (d) { if (d) { DATA = d; boot(); } }).catch(function () {}); }\n';

// The bridge IS `window.agentgemApp`, so a bundle that uses it must NAME it at least once to get a
// reference — there is no aliasing its way in. That makes this substring test total for "does this
// document talk to a host?", for the same reason capabilityScan's tool-name scan is total: gameGate
// seals every other channel out of the frame.
const HOST_API = "agentgemApp";

// TRANSPORT ONLY: give a bundle that calls the bridge the shim that defines it. It rewrites no code, so
// unlike the old-bridge codemod below — which injects a `callTool("agentgem_get_session_data")` and thus
// a capability — it can never widen a grant. That is what makes it safe to run on the SAVE path, where a
// silent widening would be a security bug. Idempotent, and a no-op for a bundle that talks to no host.
export function ensureClientShim(html: string): string {
  if (!html.includes(HOST_API)) return html;                     // talks to no host — nothing to do
  if (html.includes(MCP_CLIENT_MARKER)) return html;              // already current
  if (MCP_CLIENT_MARKER_RE.test(html)) return replaceShim(html);  // an OLDER shim — swap it wholesale
  return injectClientShim(html);                                  // no shim at all — inject
}

// Replace the <script>…older marker…</script> element with the current shim script. The shim is always a
// single <script> whose body carries the marker comment; walk from its <script open to the matching close.
function replaceShim(html: string): string {
  const markerIdx = html.search(MCP_CLIENT_MARKER_RE);
  if (markerIdx === -1) return injectClientShim(html);
  const open = html.lastIndexOf("<script", markerIdx);
  const closeToken = "</script>";
  const close = html.indexOf(closeToken, markerIdx);
  if (open === -1 || close === -1) return injectClientShim(html);
  return html.slice(0, open) + mcpAppClient().trim() + html.slice(close + closeToken.length);
}

function injectClientShim(html: string): string {
  const shim = mcpAppClient();
  // Insert at the very start of <head> so `window.agentgemApp` exists before the game's own script runs.
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${shim}`);

  // No <head>. Wrapping the WHOLE input in a synthesized document would nest a second <!doctype> and a
  // second <body> inside the new body — malformed, and gameGate admits it (it only scans for external
  // references and network syntax), so the broken bytes would be stored, dual-written to the game gem,
  // and served as the MCP Apps resource text. Splice a head into the document that already exists, and
  // only synthesize a whole one for a bare fragment. Each branch keeps the shim ahead of the game script.
  if (/<html[\s>]/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head>${shim}</head>`);
  if (/<body[\s>]/i.test(html)) return html.replace(/<body([^>]*)>/i, `<body$1>${shim}`);
  return `<!doctype html><html><head>${shim}</head><body>${html}</body></html>`;
}

export function migrateMiniappHtml(html: string): { html: string; outcome: MigrateOutcome } {
  try {
    if (html.includes(MCP_CLIENT_MARKER)) return { html, outcome: "already" };
    if (!html.includes("agentgem:request") || !html.includes("agentgem:feed")) {
      // No old bridge and no shim. Two very different documents land here, and conflating them is what
      // let a broken miniapp ship: one that never talks to a host (a sealed canvas game — nothing to do),
      // and one that CALLS the bridge but carries no shim. The latter comes from the studio agent
      // regenerating the document and dropping whatever <head> held, and from every miniapp stored before
      // the scaffolds all shipped the shim. It has no legacy code to rewrite; it is simply
      // missing its transport, so give it one. Without this it stays mute: `window.agentgemApp` is never
      // defined, the handshake never opens, and the app silently degrades to its baked data while
      // meta.json still declares `needs` — so the host advertises tools to a frame that cannot speak.
      const shimmed = ensureClientShim(html);
      return shimmed === html ? { html, outcome: "unrecognized" } : { html: shimmed, outcome: "migrated" };
    }
    if (!FEED_LISTENER_RE.test(html) || !REQUEST_DATA_RE.test(html)) {
      return { html, outcome: "unrecognized" };
    }

    const rewritten = html.replace(FEED_LISTENER_RE, NEW_FEED_LISTENER).replace(REQUEST_DATA_RE, NEW_REQUEST_DATA);
    return { html: injectClientShim(rewritten), outcome: "migrated" };
  } catch {
    return { html, outcome: "unrecognized" };
  }
}
