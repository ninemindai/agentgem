// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/__tests__/aguiStream.test.ts
import { describe, it, expect } from "vitest";
import { createAguiMapper, type AguiEvent } from "@agentgem/app/goldmine/aguiStream";
import type { ChatEvent } from "@agentgem/run";

// The AG-UI protocol's allowed event `type` values (docs.ag-ui.com) — used for the
// conformance assertion below. Only the subset this mapper emits needs to be present.
const AGUI_TYPES = new Set([
  "RUN_STARTED",
  "RUN_FINISHED",
  "RUN_ERROR",
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_END",
  "CUSTOM",
]);

function counterGenId(): () => string {
  let n = 0;
  return () => `m${++n}`;
}

describe("createAguiMapper", () => {
  it("start() emits RUN_STARTED with threadId/runId", () => {
    const mapper = createAguiMapper({ threadId: "th1", runId: "run1", genId: counterGenId() });
    expect(mapper.start()).toEqual([{ type: "RUN_STARTED", threadId: "th1", runId: "run1" }]);
  });

  it("maps a full delta→tool→delta→done sequence to the exact ordered AG-UI events", () => {
    const mapper = createAguiMapper({ threadId: "th1", runId: "run1", genId: counterGenId() });

    const events: AguiEvent[] = [];
    events.push(...mapper.start());

    const chatEvents: ChatEvent[] = [
      { type: "delta", text: "He" },
      { type: "delta", text: "llo" },
      {
        type: "tool",
        tool: { toolCallId: "t1", title: "Edit", kind: "write", status: "done" },
      },
      { type: "delta", text: "done" },
      { type: "done", result: { text: "Hellodone", toolCalls: [] } },
    ];
    for (const ev of chatEvents) events.push(...mapper.onChat(ev));

    expect(events).toEqual([
      { type: "RUN_STARTED", threadId: "th1", runId: "run1" },
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "He" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "llo" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "Edit" },
      { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: JSON.stringify({ kind: "write", status: "done" }) },
      { type: "TOOL_CALL_END", toolCallId: "t1" },
      { type: "TEXT_MESSAGE_START", messageId: "m2", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m2", delta: "done" },
      { type: "TEXT_MESSAGE_END", messageId: "m2" },
      { type: "RUN_FINISHED", threadId: "th1", runId: "run1" },
    ]);
  });

  it("tool event with no kind/status skips TOOL_CALL_ARGS", () => {
    const mapper = createAguiMapper({ threadId: "th1", runId: "run1", genId: counterGenId() });
    const out = mapper.onChat({ type: "tool", tool: { toolCallId: "t2", title: "Read" } });
    expect(out).toEqual([
      { type: "TOOL_CALL_START", toolCallId: "t2", toolCallName: "Read" },
      { type: "TOOL_CALL_END", toolCallId: "t2" },
    ]);
  });

  it("failed → RUN_ERROR, closing an open text msg first", () => {
    const mapper = createAguiMapper({ threadId: "th1", runId: "run1", genId: counterGenId() });
    mapper.onChat({ type: "delta", text: "partial" });
    const out = mapper.onChat({ type: "failed", error: "boom" });
    expect(out).toEqual([
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "RUN_ERROR", message: "boom" },
    ]);
  });

  it("failed with no open text msg → just RUN_ERROR", () => {
    const mapper = createAguiMapper({ threadId: "th1", runId: "run1", genId: counterGenId() });
    const out = mapper.onChat({ type: "failed", error: "boom" });
    expect(out).toEqual([{ type: "RUN_ERROR", message: "boom" }]);
  });

  it("phase → CUSTOM{name:'phase', value}", () => {
    const mapper = createAguiMapper({ threadId: "th1", runId: "run1", genId: counterGenId() });
    const out = mapper.onChat({ type: "phase", phase: "running" });
    expect(out).toEqual([{ type: "CUSTOM", name: "phase", value: "running" }]);
  });

  it("error() after an open delta closes the text msg then emits RUN_ERROR", () => {
    const mapper = createAguiMapper({ threadId: "th1", runId: "run1", genId: counterGenId() });
    mapper.onChat({ type: "delta", text: "hi" });
    const out = mapper.error("boom");
    expect(out).toEqual([
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "RUN_ERROR", message: "boom" },
    ]);
  });

  it("error() with no open text msg → just RUN_ERROR", () => {
    const mapper = createAguiMapper({ threadId: "th1", runId: "run1", genId: counterGenId() });
    expect(mapper.error("boom")).toEqual([{ type: "RUN_ERROR", message: "boom" }]);
  });

  it("a second delta run after a close opens a NEW text message id", () => {
    const mapper = createAguiMapper({ threadId: "th1", runId: "run1", genId: counterGenId() });
    mapper.onChat({ type: "delta", text: "first" });
    mapper.onChat({ type: "tool", tool: { toolCallId: "t1", title: "Edit" } }); // closes m1
    const out = mapper.onChat({ type: "delta", text: "second" });
    expect(out).toEqual([
      { type: "TEXT_MESSAGE_START", messageId: "m2", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m2", delta: "second" },
    ]);
  });

  it("every emitted event type is in the allowed AG-UI set (conformance)", () => {
    const mapper = createAguiMapper({ threadId: "th1", runId: "run1", genId: counterGenId() });
    const all: AguiEvent[] = [];
    all.push(...mapper.start());
    const chatEvents: ChatEvent[] = [
      { type: "delta", text: "He" },
      { type: "phase", phase: "running" },
      { type: "tool", tool: { toolCallId: "t1", title: "Edit", kind: "write", status: "done" } },
      { type: "delta", text: "done" },
      { type: "done", result: { text: "Hedone", toolCalls: [] } },
    ];
    for (const ev of chatEvents) all.push(...mapper.onChat(ev));
    all.push(...mapper.error("boom"));

    for (const e of all) expect(AGUI_TYPES.has(e.type)).toBe(true);
  });
});
