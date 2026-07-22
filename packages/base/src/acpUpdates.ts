// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/base/src/acpUpdates.ts
//
// The ACP session-update reducer, shared by every façade that folds a raw ACP
// prompt() stream into a RunResult (gem runner, chat, recommender). Moved from
// packages/run/src/acpRun.ts so @agentgem/base can host the one true fold.

// One tool the agent invoked during the run. Mirrors the fields of an ACP
// `tool_call` session update that matter for verification/observability.
export interface ToolInvocation {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: string;
}

// Everything the agent produced for one prompt: the assembled message text and the
// ordered list of tools it invoked.
export interface RunResult {
  text: string;
  toolCalls: ToolInvocation[];
  /** ACP stop reason for the turn (e.g. "end_turn", "cancelled"); absent on adapters that omit it. */
  stopReason?: string;
}

// ── Session-update reducer ───────────────────────────────────────────────────
// Pure folding of ACP session updates into a RunResult, extracted from the SDK
// loop so it's unit-testable. Handles message text plus the tool_call lifecycle:
// `tool_call` records a tool (status usually "pending"); `tool_call_update` merges
// the later status/title into the SAME tool by id so the final result reflects
// "completed"/"failed" rather than the initial "pending".
export type RunAccumulator = RunResult;

export function createAccumulator(): RunAccumulator {
  return { text: "", toolCalls: [] };
}

// A minimal shape of the SDK's `session_update.update`; we read only what we use.
interface UpdateLike {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
}

export function applyUpdate(
  acc: RunAccumulator,
  update: UpdateLike,
  handlers?: { onDelta?: (chunk: string) => void; onToolCall?: (tool: ToolInvocation) => void },
): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const block = update.content;
      if (block?.type === "text" && typeof block.text === "string") {
        acc.text += block.text;
        handlers?.onDelta?.(block.text);
      }
      return;
    }
    case "tool_call": {
      if (!update.toolCallId) return;
      const tool: ToolInvocation = {
        toolCallId: update.toolCallId,
        title: update.title ?? "",
        kind: update.kind,
        status: update.status,
      };
      acc.toolCalls.push(tool);
      handlers?.onToolCall?.(tool);   // fires once, on start — final status lands in the result
      return;
    }
    case "tool_call_update": {
      const existing = acc.toolCalls.find((t) => t.toolCallId === update.toolCallId);
      if (!existing) return;          // update for a tool we never saw start — ignore
      if (update.status !== undefined) existing.status = update.status;
      if (update.kind !== undefined) existing.kind = update.kind;
      if (update.title !== undefined && update.title !== "") existing.title = update.title;
      return;
    }
    default:
      return;
  }
}
