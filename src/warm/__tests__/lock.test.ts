// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { withWarmLock } from "../lock.js";

describe("withWarmLock", () => {
  it("runs fn and releases when the lock is free", async () => {
    const rel: string[] = [];
    const r = await withWarmLock("/home", async () => "ran", () => "skip", { acquire: () => true, release: (p) => rel.push(p) });
    expect(r).toBe("ran");
    expect(rel).toEqual(["/home/.agentgem/warm-pass.lock"]);
  });
  it("returns onSkip and does not run fn when a live holder exists", async () => {
    let ran = false;
    const r = await withWarmLock("/home", async () => { ran = true; return "ran"; }, () => "skip", { acquire: () => false, release: () => {} });
    expect(r).toBe("skip"); expect(ran).toBe(false);
  });
  it("releases even if fn throws", async () => {
    let released = false;
    await expect(withWarmLock("/home", async () => { throw new Error("boom"); }, () => "skip", { acquire: () => true, release: () => { released = true; } })).rejects.toThrow("boom");
    expect(released).toBe(true);
  });
  it("enabled=false runs fn without touching the lock", async () => {
    let acquired = false;
    const r = await withWarmLock("/home", async () => "ran", () => "skip", { acquire: () => { acquired = true; return true; }, release: () => {}, enabled: false });
    expect(r).toBe("ran"); expect(acquired).toBe(false);
  });
});
