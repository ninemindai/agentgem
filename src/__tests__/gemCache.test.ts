// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { gemNoCache, GEM_NO_CACHE_METHODS } from "@agentgem/app/gemCache";
import { GemController } from "@agentgem/app/gem.controller";

// `responseHeaders` is a WHATWG `Headers` (see @agentback/rest keys.d.ts:113), not a Map.
function run(ctor: unknown, methodName: string) {
  const headers = new Headers();
  let nexted = false;
  gemNoCache({ ctor, methodName, responseHeaders: headers } as never, () => { nexted = true; return undefined as never; });
  return { headers, nexted };
}

describe("gemNoCache", () => {
  it("sets Cache-Control: no-cache on the inventory + artifact-content reads", () => {
    for (const m of GEM_NO_CACHE_METHODS) {
      expect(run(GemController, m).headers.get("Cache-Control"), m).toBe("no-cache");
    }
  });

  // Headers.get() returns null (not undefined) for an absent header.
  it("leaves other GemController routes alone", () => {
    expect(run(GemController, "usage").headers.get("Cache-Control")).toBeNull();
  });

  it("leaves other controllers alone", () => {
    class Other {}
    expect(run(Other, "inventory").headers.get("Cache-Control")).toBeNull();
  });

  it("always calls next()", () => {
    expect(run(GemController, "inventory").nexted).toBe(true);
    expect(run(GemController, "usage").nexted).toBe(true);
  });

  it("guards both routes", () => {
    expect([...GEM_NO_CACHE_METHODS]).toEqual(["inventory", "artifactContent"]);
  });
});
