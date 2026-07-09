// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/base/src/concurrency.ts
//
// Bounded-concurrency async fan-out. Used where work is I/O-bound (parallel
// transcript reads) or where a sequential loop needlessly serializes independent
// tasks (per-project scorecard scans): overlap the tasks, but cap how many run at
// once so we never open unbounded file handles or thrash the machine.

/**
 * Order-preserving async map with a concurrency cap. Runs at most `limit` tasks
 * at a time; `out[i]` is always `fn(items[i], i)` regardless of the order tasks
 * settle in. A rejection from `fn` rejects the whole call (like `Promise.all`).
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  // Single-threaded JS: `next++` is atomic, so each worker claims a distinct index.
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i], i);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}
