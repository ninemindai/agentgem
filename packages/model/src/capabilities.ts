// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The capability <-> MCP host-tool bijection. It lives beside the GameCapability union because two
// consumers must agree on it exactly: the console's host router (which dispatches a tool call to an
// executor) and packages/play's save-time reconciliation (which derives `needs` back out of the html).
// Two copies would drift silently. Keyed by GameCapability, so adding a capability to the union without
// naming its tool is a COMPILE error — the same guard portability.ts's CAP_CLASS uses.
import type { ToolCapability, ActionCapability, GameCapability } from "./types.js";

// Capabilities the host brokers WITHOUT a per-use consent prompt — implicit consent, granted at seed
// (only the game's OWN source session). EVERY other capability reaches other data, live sessions,
// external links, or runs code, so the Runner gates it behind an explicit Allow/Deny. This is a
// security-critical classification and the single source of truth for it: importStudio auto-declares
// only NON-auto (gated) caps derived from imported html, so an imported bundle can never silently gain
// an auto-approved capability like reading the viewer's sessions. Console's consent.ts keeps a
// browser-safe mirror, pinned by a drift test.
export const AUTO_CAPS: ReadonlySet<GameCapability> = new Set<GameCapability>(["session-data"]);

// ToolCapability <-> host MCP tool name. Keyed by ToolCapability so adding a tool cap without naming its
// tool is a COMPILE error (the guard portability.ts's CAP_CLASS also relies on).
export const CAP_TOOL: Record<ToolCapability, string> = {
  "session-data": "agentgem_get_session_data",
  "live-session-events": "agentgem_subscribe_sessions",
  "local-project-access": "agentgem_get_inventory",
  "invoke-agent": "agentgem_invoke_agent",
  "context-hygiene": "agentgem_subscribe_hygiene",
};

export const TOOL_CAP: Record<string, ToolCapability> = Object.fromEntries(
  (Object.entries(CAP_TOOL) as [ToolCapability, string][]).map(([cap, tool]) => [tool, cap]),
);

// ActionCapability <-> window.agentgemApp method name. deriveNeeds() matches `agentgemApp.<method>` in
// game source. Keyed by ActionCapability: adding an action cap without naming its method is a compile error.
export const CAP_METHOD: Record<ActionCapability, string> = {
  "open-link": "openLink",
  "send-message": "sendMessage",
  "update-model-context": "updateModelContext",
};

export const METHOD_CAP: Record<string, ActionCapability> = Object.fromEntries(
  (Object.entries(CAP_METHOD) as [ActionCapability, string][]).map(([cap, m]) => [m, cap]),
);
