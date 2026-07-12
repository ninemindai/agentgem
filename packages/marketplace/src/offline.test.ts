import { describe, it, expect, vi, beforeEach } from "vitest";
import { pinGame, unpinGame, listPinned, isPinned, storageEstimate, PINNED_CACHE } from "./offline";
import { gameHtmlUrl } from "./api";

// Minimal in-memory Cache Storage mock (only the methods offline.ts uses).
function installCachesMock() {
  const store = new Map<string, Map<string, Response>>();
  const cache = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name)!;
    return {
      put: async (url: string, res: Response) => { m.set(url, res); },
      match: async (url: string) => m.get(url),
      delete: async (url: string) => m.delete(url),
      keys: async () => [...m.keys()].map((u) => new Request(u)),
    };
  };
  vi.stubGlobal("caches", { open: async (n: string) => cache(n) });
  return store;
}

const BASE = "https://api.test";

describe("offline pin store", () => {
  beforeEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

  it("pins a game: caches the html and records an index entry", async () => {
    const store = installCachesMock();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ html: "<b>x</b>" }))));

    await pinGame(BASE, "@acme/tetris", "1.0.0", "Tetris");

    expect(isPinned("@acme/tetris", "1.0.0")).toBe(true);
    const list = listPinned();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: "@acme/tetris", version: "1.0.0", title: "Tetris" });
    expect(list[0].size).toBeGreaterThan(0);
    // stored under the SAME url getGameHtml would fetch
    expect(store.get(PINNED_CACHE)!.has(gameHtmlUrl(BASE, "@acme/tetris", "1.0.0"))).toBe(true);
  });

  it("unpins: removes the cache entry and the index row", async () => {
    const store = installCachesMock();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ html: "<b>x</b>" }))));
    await pinGame(BASE, "@acme/tetris", "1.0.0", "Tetris");

    await unpinGame(BASE, "@acme/tetris", "1.0.0");

    expect(isPinned("@acme/tetris", "1.0.0")).toBe(false);
    expect(listPinned()).toHaveLength(0);
    expect(store.get(PINNED_CACHE)!.size).toBe(0);
  });

  it("throws (and does not record) when the fetch fails", async () => {
    installCachesMock();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(pinGame(BASE, "@acme/x", "1.0.0", "X")).rejects.toThrow();
    expect(listPinned()).toHaveLength(0);
  });

  it("rolls back the cache entry when the index write fails (localStorage quota)", async () => {
    const store = installCachesMock();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ html: "<b>x</b>" }))));
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    try {
      await expect(pinGame(BASE, "@acme/tetris", "1.0.0", "Tetris")).rejects.toThrow();
    } finally {
      setItem.mockRestore();
    }

    expect(store.get(PINNED_CACHE)!.has(gameHtmlUrl(BASE, "@acme/tetris", "1.0.0"))).toBe(false);
    expect(listPinned()).toHaveLength(0);
  });
});

describe("storageEstimate", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it("returns usage/quota from navigator.storage.estimate", async () => {
    vi.stubGlobal("navigator", { storage: { estimate: vi.fn(async () => ({ usage: 42, quota: 100 })) } });
    await expect(storageEstimate()).resolves.toEqual({ usage: 42, quota: 100 });
  });

  it("returns null when navigator.storage is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(storageEstimate()).resolves.toBeNull();
  });
});
