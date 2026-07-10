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
import type { GameCapability } from "@agentgem/model";
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
function codeSkeleton(code: string): string {
  let out = "";
  for (let i = 0; i < code.length; ) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {         // keep the quotes, drop what is between them
      out += c;
      for (i++; i < code.length; ) {
        if (code[i] === "\\") { i += 2; continue; }
        if (code[i++] === c) { out += c; break; }
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

// `callTool(` followed by an identifier start — i.e. a variable, not a literal. The shim's own
// `callTool: function (name, args)` is a DEFINITION, not a call, so the `(` never follows the name.
const DYNAMIC_CALL = /\bcallTool\s*\(\s*[A-Za-z_$]/;

// MINIAPP_BUILDER_BRIEF requires literal tool-name strings, because deriveNeeds() reads the source: a
// name it cannot see is a capability it prunes, and the call then fails at runtime with -32601. This
// turns that convention into a save-time error the agent can self-repair from.
export function hasDynamicToolCall(html: string): boolean {
  return DYNAMIC_CALL.test(codeSkeleton(scannableCode(html)));
}
