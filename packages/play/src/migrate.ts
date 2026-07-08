// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Codemod for stored miniapps: rewrites the old private postMessage bridge
// (`agentgem:request` / `agentgem:feed`, baked by `replayScaffold()` in scaffolds.ts) to the standard
// MCP Apps client shim (`mcpAppClient()` in mcpAppClient.ts). Never throws — a miniapp that predates the
// old bridge, or that has already been migrated, is reported rather than blown up; the caller (the
// storage-layer route) decides what "unrecognized" means for its flow.
import { MCP_CLIENT_MARKER, mcpAppClient } from "./mcpAppClient.js";

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

function injectClientShim(html: string): string {
  // Same head-injection approach as sandboxDoc: insert at the very start of <head> so
  // `window.agentgemApp` exists before the game's own script runs. Falls back to synthesizing a
  // <head> if the document doesn't have one (mirrors sandboxDoc's fallback).
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${mcpAppClient()}`);
  return `<!doctype html><html><head>${mcpAppClient()}</head><body>${html}</body></html>`;
}

export function migrateMiniappHtml(html: string): { html: string; outcome: MigrateOutcome } {
  try {
    if (html.includes(MCP_CLIENT_MARKER)) return { html, outcome: "already" };
    if (!html.includes("agentgem:request") || !html.includes("agentgem:feed")) {
      return { html, outcome: "unrecognized" };
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
