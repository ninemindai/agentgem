// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { contribute } from "@agentgem/app/benchmark/contributeCore";

// Fully-injected deps: no fs, no net, no scan. Exercises the enumerate → match →
// attest → post loop and the ingredients-only contract (build must never see facets).
const deps = () => ({
  enabled: () => true,
  identity: { publicKey: "PK" } as any,
  listOwned: vi.fn(async () => [
    { key: "me/demo", version: "1", name: "demo" },
    { key: "me/ghost", version: "1", name: "ghost" },
  ]),
  readGem: vi.fn((name: string) =>
    name === "demo" ? ({ name: "demo", artifacts: [{ type: "skill", name: "qa" }] } as any) : null,
  ),
  scan: vi.fn(
    () =>
      ({
        artifacts: [{ type: "skill", name: "qa", invocations: 1, sessionsUsedIn: 1 }],
        sessions: { scanned: 1, firstMs: 0, lastMs: 0, spanDays: 1 },
        models: [],
      }) as any,
  ),
  digestOf: vi.fn(() => "sha256:d"),
  build: vi.fn((a: any) => {
    expect(a.facets).toBeUndefined(); // ingredients-only: never judge, never pass outcomes
    expect(a.account).toBeNull();
    return { gem: { name: a.gem.name } };
  }),
  sign: vi.fn((a: any) => a),
  post: vi.fn(async () => ({ ingestId: "i1" })),
});

describe("contributeCore", () => {
  it("no-ops when disabled", async () => {
    const d = { ...deps(), enabled: () => false };
    expect(await contribute(d as any)).toEqual({ enabled: false, results: [] });
    expect(d.post).not.toHaveBeenCalled();
    expect(d.scan).not.toHaveBeenCalled();
  });

  it("attests owned gems with a matching workspace, skips the rest, never judges", async () => {
    const d = deps();
    const r = await contribute(d as any);
    expect(d.scan).toHaveBeenCalledTimes(1); // scanned ONCE, reused across gems
    expect(d.post).toHaveBeenCalledTimes(1);
    expect(r).toEqual({
      enabled: true,
      results: [
        { gem: "demo", status: "ingested" },
        { gem: "ghost", status: "skipped", reason: "no local workspace" },
      ],
    });
  });

  it("isolates a per-gem post failure", async () => {
    const d = deps();
    d.post = vi.fn(async () => {
      throw new Error("net");
    });
    const r = await contribute(d as any);
    expect(r.results[0]).toMatchObject({ gem: "demo", status: "failed" });
  });

  it("surfaces a digestOf failure as failed instead of posting an empty digest", async () => {
    const d = deps();
    d.listOwned = vi.fn(async () => [
      { key: "me/demo", version: "1", name: "demo" },
      { key: "me/other", version: "1", name: "other" },
    ]);
    d.readGem = vi.fn(
      (name: string) => ({ name, artifacts: [{ type: "skill", name: "qa" }] }) as any,
    );
    d.digestOf = vi.fn((gem: any) => {
      if (gem.name === "demo") throw new Error("lock read failed");
      return "sha256:other";
    }) as any;
    const r = await contribute(d as any);
    expect(d.build).not.toHaveBeenCalledWith(expect.objectContaining({ gem: expect.objectContaining({ name: "demo" }) }));
    expect(d.post).toHaveBeenCalledTimes(1); // only "other" reaches post
    expect(r.results).toEqual([
      { gem: "demo", status: "failed", reason: "lock read failed" },
      { gem: "other", status: "ingested" },
    ]);
  });
});
