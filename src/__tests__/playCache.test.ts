// src/__tests__/playCache.test.ts
import { describe, it, expect, vi } from "vitest";
import { playNoCache, NO_CACHE_METHODS } from "../playCache.js";
import { PlayController } from "../play.controller.js";
import type { RestDispatchInfo } from "@agentback/rest";

// Drive the hook with a minimal RestDispatchInfo. The hook only reads ctor/methodName and writes
// responseHeaders, so the rest of the shape is irrelevant here.
function run(ctor: Function, methodName: string) {
  const responseHeaders = new Headers();
  const next = vi.fn(async () => "result");
  const info = { ctor, methodName, responseHeaders } as unknown as RestDispatchInfo;
  return { responseHeaders, next, ran: playNoCache(info, next) };
}

describe("playNoCache dispatch hook", () => {
  // Express sends an ETag but no Cache-Control. A bare validator lets the browser apply *heuristic*
  // freshness and serve a cached body without revalidating — so the Studio can render html the agent
  // already replaced on disk.
  it("marks the miniapp html read no-cache so the browser revalidates", async () => {
    const { responseHeaders, ran } = run(PlayController, "miniapp");
    await ran;
    expect(responseHeaders.get("Cache-Control")).toBe("no-cache");
  });

  it("covers every mutable Play read", async () => {
    for (const m of NO_CACHE_METHODS) {
      const { responseHeaders, ran } = run(PlayController, m);
      await ran;
      expect(responseHeaders.get("Cache-Control"), m).toBe("no-cache");
    }
  });

  // no-cache, never no-store: the ETag still answers 304, so revalidation costs a conditional
  // request rather than re-downloading ~19KB of html on every mount.
  it("does not use no-store", async () => {
    const { responseHeaders, ran } = run(PlayController, "miniapp");
    await ran;
    expect(responseHeaders.get("Cache-Control")).not.toContain("no-store");
  });

  // The whole point of keying on ctor+methodName rather than a URL: a write on the same controller,
  // and another controller's same-named method, are untouched — no path string to drift from the
  // route table.
  it("leaves Play writes and other controllers alone", async () => {
    for (const m of ["save", "migrate", "import"]) {
      const { responseHeaders, ran } = run(PlayController, m);
      await ran;
      expect(responseHeaders.get("Cache-Control"), m).toBeNull();
    }
    class OtherController { async miniapp() {} }        // same method NAME, different controller
    const { responseHeaders, ran } = run(OtherController, "miniapp");
    await ran;
    expect(responseHeaders.get("Cache-Control")).toBeNull();
  });

  it("always calls next() exactly once and returns its result", async () => {
    const hit = run(PlayController, "miniapp");
    await expect(hit.ran).resolves.toBe("result");
    expect(hit.next).toHaveBeenCalledTimes(1);

    const miss = run(PlayController, "save");
    await expect(miss.ran).resolves.toBe("result");
    expect(miss.next).toHaveBeenCalledTimes(1);
  });

  // A hook must not swallow the pipeline's errors — a 404 from readMiniapp still throws. The header
  // is set before next(), and the framework flushes responseHeaders in a `finally`, so it rides
  // along with the error response too (a 404 must not be heuristically cached either).
  it("propagates errors from next(), header already set", async () => {
    const responseHeaders = new Headers();
    const info = { ctor: PlayController, methodName: "miniapp", responseHeaders } as unknown as RestDispatchInfo;
    await expect(playNoCache(info, async () => { throw new Error("not found"); })).rejects.toThrow("not found");
    expect(responseHeaders.get("Cache-Control")).toBe("no-cache");
  });
});
