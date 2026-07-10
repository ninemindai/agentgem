// src/__tests__/arcadeCache.test.ts
import { describe, it, expect, vi } from "vitest";
import { gameHtmlCache, CACHED_METHODS } from "../arcadeCache.js";
import { AggregatorController } from "../aggregator.controller.js";
import type { RestDispatchInfo } from "@agentback/rest";

function run(ctor: Function, methodName: string) {
  const responseHeaders = new Headers();
  const next = vi.fn(async () => "result");
  const info = { ctor, methodName, responseHeaders } as unknown as RestDispatchInfo;
  return { responseHeaders, next, ran: gameHtmlCache(info, next) };
}

describe("gameHtmlCache dispatch hook", () => {
  it("lets the browser reuse a game's sealed html without a request", async () => {
    const { responseHeaders, ran } = run(AggregatorController, "gameHtml");
    await ran;
    expect(responseHeaders.get("Cache-Control")).toMatch(/max-age=\d+/);
    expect(responseHeaders.get("Cache-Control")).toContain("public");
  });

  // A republish REUSES (key, version) — upsertGemArchive overwrites the bytes. So the response is NOT
  // immutable: a publisher who fixes a bug and republishes 0.1.0 must not be frozen out of every
  // reader's cache. Short max-age + stale-while-revalidate: fast repeat visits, bounded staleness.
  it("never marks the html immutable — a republish reuses the same key+version", async () => {
    const { responseHeaders, ran } = run(AggregatorController, "gameHtml");
    await ran;
    expect(responseHeaders.get("Cache-Control")).not.toContain("immutable");
    expect(responseHeaders.get("Cache-Control")).toContain("stale-while-revalidate");
  });

  it("keeps max-age short enough that a republish surfaces within minutes", async () => {
    const { responseHeaders, ran } = run(AggregatorController, "gameHtml");
    await ran;
    const maxAge = Number(/max-age=(\d+)/.exec(responseHeaders.get("Cache-Control") ?? "")?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(600);
  });

  it("covers every cached aggregator read", async () => {
    for (const m of CACHED_METHODS) {
      const { responseHeaders, ran } = run(AggregatorController, m);
      await ran;
      expect(responseHeaders.get("Cache-Control"), m).toContain("public");
    }
  });

  // Keying on ctor+methodName, not a URL: the play beacon and other controllers stay untouched.
  it("leaves aggregator writes and other controllers alone", async () => {
    for (const m of ["gamePlay", "ingest", "publishGem", "sweep"]) {
      const { responseHeaders, ran } = run(AggregatorController, m);
      await ran;
      expect(responseHeaders.get("Cache-Control"), m).toBeNull();
    }
    class OtherController { async gameHtml() {} }
    const { responseHeaders, ran } = run(OtherController, "gameHtml");
    await ran;
    expect(responseHeaders.get("Cache-Control")).toBeNull();
  });

  it("always calls next() exactly once and returns its result", async () => {
    const hit = run(AggregatorController, "gameHtml");
    await expect(hit.ran).resolves.toBe("result");
    expect(hit.next).toHaveBeenCalledTimes(1);
    const miss = run(AggregatorController, "gamePlay");
    await expect(miss.ran).resolves.toBe("result");
    expect(miss.next).toHaveBeenCalledTimes(1);
  });

  // Opposite of playNoCache, which sets its header BEFORE next() so a 404 is also uncacheable. Here
  // the header only means "this game html is reusable", so it must ride only a successful response —
  // the framework flushes responseHeaders in a `finally`, and a cached 404 would outlive the publish
  // that fixes it. Set after next() resolves; an error leaves the header unset.
  it("propagates errors from next() and does NOT cache the failure", async () => {
    const responseHeaders = new Headers();
    const info = { ctor: AggregatorController, methodName: "gameHtml", responseHeaders } as unknown as RestDispatchInfo;
    await expect(gameHtmlCache(info, async () => { throw new Error("no game"); })).rejects.toThrow("no game");
    expect(responseHeaders.get("Cache-Control")).toBeNull();
  });
});
