// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/sse/pump.ts
//
// Bridge a push-style producer (callbacks) to the pull-style async iterable an
// agentback `streamOf:` route yields. Shared by the SSE controllers that wrap a
// push-based compute core (InsightsController, WorkflowController, …) — the one
// non-trivial piece a raw Express handler didn't need, extracted here so each
// migrated route reuses it rather than re-deriving the queue/wake discipline.

/**
 * Adapt a push-style producer into the async iterable the framework pulls.
 * `run` emits items via `emit`; the generator yields them in order and ends
 * when `run` resolves. A `run` rejection surfaces after the queue drains.
 *
 * Contract for reuse: `run` should handle its own errors (the callers wrap
 * compute in a try/catch that emits a terminal `failed` item and never
 * rethrows). If the consumer abandons the generator early (client disconnect →
 * the framework calls `iterator.return()`), the trailing `await finished` is
 * skipped, so a `run` that *rejects* would leave an unhandled rejection.
 */
export async function* pump<T>(
  run: (emit: (v: T) => void) => Promise<void>,
): AsyncGenerator<T> {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const emit = (v: T) => {
    queue.push(v);
    wake?.();
    wake = null;
  };
  const finished = run(emit).finally(() => {
    done = true;
    wake?.();
    wake = null;
  });
  while (true) {
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    if (done) break;
    await new Promise<void>((r) => (wake = r));
  }
  await finished; // surface a producer rejection to the framework, post-drain
}
