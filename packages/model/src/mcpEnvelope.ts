// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The MCP connector call envelope, canonical for every layer (spec 4A). The server route derives
// `payload` ONCE with derivePayload(); the console router and the in-html shim mirror the error
// codes and are pinned to THIS list by drift tests — four hand-kept copies of a wire contract is
// the #446 drift class, on the security-relevant path.
//
// The code union is the FULL mirrored window.claude.mcp contract set, not just what v1 emits:
// consumers branch on `code`, and a later server version emitting a new code must not require a
// lockstep client change. Additive-only.

export const MCP_ERROR_CODES = [
  "needs_reauth",
  "server_not_connected",
  "selection_required",
  "server_not_found",
  "server_unavailable",
  "not_in_manifest",
  "blocked_by_policy",
  "approval_required",
  "tool_error",
  "bad_request",
  "cancelled",
  "rate_limited",
  "upstream_error",
  "not_granted",
  "capability_disabled",
  "capability_removed",
  "transform_error",
] as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: string; [k: string]: unknown };

export interface McpCallResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
  payload?: unknown;
}

// `payload` is the JSON answer most connectors return: structuredContent when present, else the
// first text block parsed as JSON when it parses, else that text verbatim, else undefined. One
// implementation — the shim passes the server-derived value through, never re-derives.
export function derivePayload(result: Pick<McpCallResult, "content" | "structuredContent">): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content.find((b): b is { type: "text"; text: string } => b.type === "text" && typeof (b as { text?: unknown }).text === "string");
  if (!text) return undefined;
  try { return JSON.parse(text.text); } catch { return text.text; }
}
