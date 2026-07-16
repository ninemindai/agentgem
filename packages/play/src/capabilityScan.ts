// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Derive a miniapp's `needs` from its html, and reconcile that against what meta.json declares.
//
// Why a static scan is TOTAL here: gameGate bans fetch/XMLHttpRequest/WebSocket/EventSource/
// importScripts/sendBeacon outright, so `window.agentgemApp` is the ONLY channel a sealed miniapp has
// to the outside world. There is no second place a capability can hide. (This would not hold for an
// ordinary web app.)
//
// We match a tool name ANYWHERE in executable code, not just inside callTool(...): scaffolds.ts
// receives session data purely by comparing `p.toolName === "agentgem_get_session_data"` inside
// onNotification and never calls. A callTool-only scan would prune a capability the app truly receives.
//
// A dynamic tool name — callTool(t) where t is a variable — scans as nothing and gets pruned. That hole
// is closed by convention, not by this module: MINIAPP_BUILDER_BRIEF requires literal tool-name strings.
import type { GameCapability, McpNeed } from "@agentgem/model";
import { TOOL_CAP, METHOD_CAP } from "@agentgem/model";
import { scannableCode } from "./gameGate.js";

export interface Reconciled {
  needs: GameCapability[];    // the reconciled truth: exactly what the code uses
  pruned: GameCapability[];   // declared, never used — narrowing, always safe, but reported
  missing: GameCapability[];  // used, never declared — widening, must be an authored act
}

export function deriveNeeds(html: string): GameCapability[] {
  const code = scannableCode(html);
  const tool = Object.keys(TOOL_CAP).filter((t) => code.includes(t)).map((t) => TOOL_CAP[t]);
  // Anchor on `agentgemApp.` — a bare `sendMessage` is a plausible game-local function name, and a bare
  // match would over-declare (then reconcileNeeds prunes it, or the Runner prompts for consent the game
  // never needs). The bridge cannot be aliased without naming `agentgemApp` at least once (see migrate.ts
  // HOST_API), so anchoring loses nothing a total scan would keep. KNOWN GAP: `var a = agentgemApp; a.openLink`
  // aliases past it — closed by convention in MINIAPP_BUILDER_BRIEF + the save-time missing-cap error, the
  // same way hasDynamicToolCall handles dynamic tool names.
  const method = Object.keys(METHOD_CAP)
    .filter((m) => code.includes(`agentgemApp.${m}`))
    .map((m) => METHOD_CAP[m]);
  return [...tool, ...method].sort();
}

export function reconcileNeeds(html: string, declared: GameCapability[] | undefined): Reconciled {
  const needs = deriveNeeds(html);
  const d = declared ?? [];
  return {
    needs,
    missing: needs.filter((c) => !d.includes(c)),
    pruned: [...new Set(d.filter((c) => !needs.includes(c)))].sort(),
  };
}

// The code with comments removed and every string/template literal EMPTIED to its bare quotes. Only
// hasDynamicToolCall() uses it, and only to ask "is the argument an identifier rather than a literal?".
//
// Both transforms exist to kill false positives: `MINIAPP_BUILDER_BRIEF` states the rule using the text
// `callTool(name)`, so an agent that echoes it into a comment — or into a help string — must not have
// its save blocked by it.
//
// Best-effort by design: it models neither regex literals nor `${}` interpolation, and a stray
// apostrophe in markup ("don't") makes it treat following code as a string. EVERY such error only DROPS
// text, and dropping text can only make hasDynamicToolCall() MISS a dynamic call — never invent one. A
// miss is exactly the pre-existing behaviour, so the failure direction is safe.
//
// This must never be used to narrow deriveNeeds(): there, a missed match prunes a capability the miniapp
// really uses, and the app breaks at runtime with -32601.
//
// Shared walker behind codeSkeleton() and stripComments(): drops // and /* */ comments; string
// and template literals are either EMPTIED to bare quotes (keepStrings=false — the skeleton, for
// "is this argument an identifier?" questions) or copied through (keepStrings=true — for reading
// literal arguments while still ignoring commented-out code). Same best-effort caveats as before:
// no regex-literal or `${}` modeling; errors only DROP text, never invent it.
function walkCode(code: string, keepStrings: boolean): string {
  let out = "";
  for (let i = 0; i < code.length; ) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {         // string: keep quotes; body per keepStrings
      out += c;
      for (i++; i < code.length; ) {
        if (code[i] === "\\") { if (keepStrings) out += code[i] + (code[i + 1] ?? ""); i += 2; continue; }
        const ch = code[i++];
        if (ch === c) { out += c; break; }
        if (keepStrings) out += ch;
      }
      continue;
    }
    if (c === "/" && code[i + 1] === "/") { while (i < code.length && code[i] !== "\n") i++; continue; }
    if (c === "/" && code[i + 1] === "*") {
      for (i += 2; i < code.length && !(code[i] === "*" && code[i + 1] === "/"); i++);
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function codeSkeleton(code: string): string { return walkCode(code, false); }
function stripComments(code: string): string { return walkCode(code, true); }

// `callTool(` followed by an identifier start — a variable, not a literal. The shim's own
// `callTool: function (name, args)` is a DEFINITION, not a call, so the `(` never follows the name.
// The `(?<!mcp\s*\.\s*)` carve-out: `agentgemApp.mcp.callTool(server, tool)` is the CONNECTOR
// surface, where declarations are authoritative and non-literal calls are a save-time WARNING
// (mcpUsageWarnings), never this hard error — runtime manifest enforcement is that path's boundary.
const DYNAMIC_CALL = /(?<!mcp\s*\.\s*)\bcallTool\s*\(\s*[A-Za-z_$]/;

// MINIAPP_BUILDER_BRIEF requires literal tool-name strings, because deriveNeeds() reads the source: a
// name it cannot see is a capability it prunes, and the call then fails at runtime with -32601. This
// turns that convention into a save-time error the agent can self-repair from.
export function hasDynamicToolCall(html: string): boolean {
  return DYNAMIC_CALL.test(codeSkeleton(scannableCode(html)));
}

// ---- MCP connectors (spec §2, D10: declared-authoritative) ----
//
// Unlike `needs`, the mcp scan is ASSISTIVE ONLY. It auto-fills manifest entries from literal
// calls it can see and warns about usage it cannot resolve — but a declaration is never pruned
// and a save is never blocked on scan blindness. Rationale: wrappers, constants, and dynamic tool
// selection are legitimate app structure (a ported claude.ai artifact wraps every call), and the
// server-side manifest check on /api/play/mcp/call is the real security boundary. Pruning what a
// regex cannot see would break those apps at runtime with not_in_manifest.
//
// KNOWN GAP (accepted, same family as the agentgemApp alias gap above): `const m = agentgemApp.mcp;
// m.callTool(...)` derives nothing and dodges the warning regexes. The declaration still covers it.
//
// A literal pair inside a quoted STRING ("see agentgemApp.mcp.callTool(\"x\", \"y\")") still
// derives a phantom entry — stripComments keeps string bodies by design. A phantom entry only
// widens the consent card the viewer reads; it grants nothing the app never calls. deriveNeeds()
// accepts the same trade for bare tool names.

const MCP_LITERAL_CALL = /\bagentgemApp\s*\.\s*mcp\s*\.\s*(?:callTool|watchTool)\s*\(\s*(["'`])((?:(?!\1).)+)\1\s*,\s*(["'`])((?:(?!\3).)+)\3/g;

export function deriveMcpNeeds(html: string): McpNeed[] {
  const code = stripComments(scannableCode(html));   // comments never author a manifest entry
  const map = new Map<string, Set<string>>();
  for (const m of code.matchAll(MCP_LITERAL_CALL)) {
    const server = m[2];
    const tool = m[4];
    if (!map.has(server)) map.set(server, new Set());
    map.get(server)!.add(tool);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, tools]) => ({ server, tools: [...tools].sort() }));
}

export function mergeMcpNeeds(declared: McpNeed[] | undefined, derived: McpNeed[]): McpNeed[] {
  const map = new Map<string, Set<string>>();
  for (const list of [declared ?? [], derived]) {
    for (const n of list) {
      if (!map.has(n.server)) map.set(n.server, new Set());
      for (const t of n.tools) map.get(n.server)!.add(t);
    }
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, tools]) => ({ server, tools: [...tools].sort() }));
}

// A connector call where EITHER argument is non-literal — the scan cannot verify it against the
// manifest. Evaluated on the SKELETON, where every literal is emptied to bare quotes: a literal
// arg therefore starts with a quote character, so "starts with anything else" = dynamic. Two
// alternatives: dynamic first arg (`callTool(t` / `callTool(pick()`), or emptied-literal first
// arg then a dynamic second (`callTool("", t`). Warning copy names the runtime failure so the
// author (usually the Studio agent) can self-repair by declaring.
const MCP_DYNAMIC_CALL = /\bmcp\s*\.\s*(?:callTool|watchTool)\s*\((?:\s*(?!["'`])[^)\s]|\s*(["'`])\1\s*,\s*(?!["'`])[^)\s])/;
const MCP_ANY_USE = /\bagentgemApp\s*\.\s*mcp\b/;

export function mcpUsageWarnings(html: string, declared: McpNeed[] | undefined): string[] {
  const skeleton = codeSkeleton(scannableCode(html));
  const warnings: string[] = [];
  if (MCP_DYNAMIC_CALL.test(skeleton)) {
    warnings.push(
      'connector call with a non-literal server/tool argument — the static scan cannot verify it; ensure every (server, tool) pair it can reach is declared in meta.json "mcpNeeds", or the call fails at runtime with not_in_manifest',
    );
  }
  if (MCP_ANY_USE.test(skeleton) && !declared?.length && deriveMcpNeeds(html).length === 0) {
    warnings.push(
      'miniapp references agentgemApp.mcp but declares no "mcpNeeds" — every connector call will fail at runtime with not_in_manifest',
    );
  }
  return warnings;
}
