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
import { TOOL_CAP } from "@agentgem/model";
import { scannableCode } from "./gameGate.js";

export interface Reconciled {
  needs: GameCapability[];    // the reconciled truth: exactly what the code uses
  pruned: GameCapability[];   // declared, never used — narrowing, always safe, but reported
  missing: GameCapability[];  // used, never declared — widening, must be an authored act
}

export function deriveNeeds(html: string): GameCapability[] {
  const code = scannableCode(html);
  return Object.keys(TOOL_CAP)
    .filter((tool) => code.includes(tool))
    .map((tool) => TOOL_CAP[tool])
    .sort();
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
