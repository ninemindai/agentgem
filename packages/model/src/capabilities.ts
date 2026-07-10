// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The capability <-> MCP host-tool bijection. It lives beside the GameCapability union because two
// consumers must agree on it exactly: the console's host router (which dispatches a tool call to an
// executor) and packages/play's save-time reconciliation (which derives `needs` back out of the html).
// Two copies would drift silently. Keyed by GameCapability, so adding a capability to the union without
// naming its tool is a COMPILE error — the same guard portability.ts's CAP_CLASS uses.
import type { GameCapability } from "./types.js";

export const CAP_TOOL: Record<GameCapability, string> = {
  "session-data": "agentgem_get_session_data",
  "live-session-events": "agentgem_subscribe_sessions",
  "local-project-access": "agentgem_get_inventory",
  "invoke-agent": "agentgem_invoke_agent",
};

export const TOOL_CAP: Record<string, GameCapability> = Object.fromEntries(
  (Object.entries(CAP_TOOL) as [GameCapability, string][]).map(([cap, tool]) => [tool, cap]),
);
