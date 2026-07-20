// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/aguiStream.ts
//
// Pure, stateful mapper: translates AgentGem's ChatEvent stream (chatSession.ts) into
// standard AG-UI protocol events (docs.ag-ui.com). No I/O — the SSE/Express wiring that
// drives this over the wire lives in a separate task. State is just an optionally-open
// assistant text message id, so a run of deltas coalesces into one TEXT_MESSAGE_* triple
// and any non-text event (tool/done/failed) closes it first.
import type { ChatEvent } from "@agentgem/run";

export interface AguiEvent {
  type: string;
  [k: string]: unknown;
}

export interface AguiMapper {
  start(): AguiEvent[];
  onChat(ev: ChatEvent): AguiEvent[];
  error(message: string): AguiEvent[];
}

export function createAguiMapper(o: { threadId: string; runId: string; genId: () => string }): AguiMapper {
  const { threadId, runId, genId } = o;
  let textMsgId: string | null = null;

  // Closes any open assistant text message, returning the TEXT_MESSAGE_END event (if any).
  function closeText(): AguiEvent[] {
    if (textMsgId === null) return [];
    const id = textMsgId;
    textMsgId = null;
    return [{ type: "TEXT_MESSAGE_END", messageId: id }];
  }

  return {
    start(): AguiEvent[] {
      return [{ type: "RUN_STARTED", threadId, runId }];
    },

    onChat(ev: ChatEvent): AguiEvent[] {
      switch (ev.type) {
        case "delta": {
          const out: AguiEvent[] = [];
          if (textMsgId === null) {
            textMsgId = genId();
            out.push({ type: "TEXT_MESSAGE_START", messageId: textMsgId, role: "assistant" });
          }
          out.push({ type: "TEXT_MESSAGE_CONTENT", messageId: textMsgId, delta: ev.text });
          return out;
        }
        case "tool": {
          const out = closeText();
          const { toolCallId, title, kind, status } = ev.tool;
          out.push({ type: "TOOL_CALL_START", toolCallId, toolCallName: title });
          if (kind !== undefined || status !== undefined) {
            out.push({ type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify({ kind, status }) });
          }
          out.push({ type: "TOOL_CALL_END", toolCallId });
          return out;
        }
        case "phase":
          return [{ type: "CUSTOM", name: "phase", value: ev.phase }];
        case "done":
          return [...closeText(), { type: "RUN_FINISHED", threadId, runId }];
        case "failed":
          return [...closeText(), { type: "RUN_ERROR", message: ev.error }];
        default:
          return [];
      }
    },

    error(message: string): AguiEvent[] {
      return [...closeText(), { type: "RUN_ERROR", message }];
    },
  };
}
