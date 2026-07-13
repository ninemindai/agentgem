// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { pump } from "../pump.js";

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe("pump (push -> pull bridge)", () => {
  it("yields emitted items in order, across await points, then completes", async () => {
    const seq = await drain(pump<number>(async (emit) => {
      emit(1);
      emit(2);
      await Promise.resolve();
      emit(3);
    }));
    expect(seq).toEqual([1, 2, 3]);
  });

  it("surfaces a producer rejection after draining the queue", async () => {
    const gen = pump<number>(async (emit) => {
      emit(9);
      throw new Error("late");
    });
    const first = await gen.next();
    expect(first.value).toBe(9); // queued item drains first
    await expect(gen.next()).rejects.toThrow("late");
  });
});
