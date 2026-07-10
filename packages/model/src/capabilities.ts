// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The capability <-> MCP host-tool bijection. It lives beside the GameCapability union because two
// consumers must agree on it exactly: the console's host router (which dispatches a tool call to an
// executor) and packages/play's save-time reconciliation (which derives `needs` back out of the html).
// Two copies would drift silently. Keyed by GameCapability, so adding a capability to the union without
// naming its tool is a COMPILE error — the same guard portability.ts's CAP_CLASS uses.
import type { ToolCapability, ActionCapability } from "./types.js";

// ToolCapability <-> host MCP tool name. Keyed by ToolCapability so adding a tool cap without naming its
// tool is a COMPILE error (the guard portability.ts's CAP_CLASS also relies on).
export const CAP_TOOL: Record<ToolCapability, string> = {
  "session-data": "agentgem_get_session_data",
  "live-session-events": "agentgem_subscribe_sessions",
  "local-project-access": "agentgem_get_inventory",
  "invoke-agent": "agentgem_invoke_agent",
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
