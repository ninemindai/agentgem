// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Browser-safe mirror of @agentgem/model's MCP_ERROR_CODES. The console is bundled for the browser
// (scripts/build-console.mjs) and @agentgem/model's barrel pulls node:fs/os/path, so it cannot be
// value-imported here — same reason consent.ts hand-copies CAP_TOOL. Pinned to the canonical union by
// mcpErrors.drift.test.ts. Adding a code upstream (e.g. server_config_changed) fails that test until
// mirrored here.
export const MCP_ERROR_CODES = [
  "needs_reauth", "server_config_changed", "server_not_connected", "selection_required",
  "server_not_found", "server_unavailable", "not_in_manifest", "blocked_by_policy",
  "approval_required", "tool_error", "bad_request", "cancelled", "rate_limited",
  "upstream_error", "not_granted", "capability_disabled", "capability_removed",
  "transform_error",
] as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];
