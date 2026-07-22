// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/base/src/acpTurn.ts
//
// The unified ACP turn façade — the consolidation the acpRun header promised
// ("the two connectFns should be unified"). promptRun is the ONE prompt-and-fold
// every caller (gem runner, chat, recommender) routes through; turnEvents is the
// push→pull bridge (queue + wake) extracted from ChatManager.sendMessage so live
// streaming isn't re-invented per surface. Shape inspired by acpx's AcpRuntimeTurn
// (events stream + terminal result), collapsed to what our callers actually use.
import type { RawAcpSession } from "./acpSession.js";
import { createAccumulator, applyUpdate, type RunResult, type ToolInvocation } from "./acpUpdates.js";

export interface PromptHandlers {
  onDelta?: (chunk: string) => void;
  onToolCall?: (tool: ToolInvocation) => void;
}

/** Send one turn on a raw session and fold its updates into a RunResult. */
export async function promptRun(
  session: Pick<RawAcpSession, "prompt">,
  text: string,
  handlers?: PromptHandlers,
): Promise<RunResult> {
  const acc = createAccumulator();
  const stopReason = await session.prompt(text, (u) =>
    applyUpdate(acc, (u ?? {}) as Parameters<typeof applyUpdate>[1], handlers),
  );
  return { ...acc, stopReason };
}

export type TurnEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; tool: ToolInvocation }
  | { type: "done"; result: RunResult }
  | { type: "failed"; error: string };

/**
 * Bridge a push-callback turn into a pull async generator, yielding events AS they
 * arrive (not buffered until the end — a long turn must be distinguishable from a
 * hang). `start` receives the two push handlers and returns the turn's result.
 */
export async function* turnEvents(
  start: (onDelta: (c: string) => void, onToolCall: (t: ToolInvocation) => void) => Promise<RunResult>,
): AsyncGenerator<TurnEvent> {
  const queue: TurnEvent[] = [];
  let wake: (() => void) | null = null;
  const bump = () => { if (wake) { wake(); wake = null; } };
  let settled = false;
  let result: RunResult | undefined;
  let error: Error | undefined;

  const running = start(
    (text) => { queue.push({ type: "delta", text }); bump(); },
    (tool) => { queue.push({ type: "tool", tool }); bump(); },
  )
    .then((r) => { result = r; })
    .catch((e) => { error = e as Error; })
    .finally(() => { settled = true; bump(); });

  while (true) {
    while (queue.length) yield queue.shift()!;
    if (settled) break;
    await new Promise<void>((res) => { wake = res; });
  }
  await running;

  if (error) { yield { type: "failed", error: error.message }; return; }
  yield { type: "done", result: result! };
}
