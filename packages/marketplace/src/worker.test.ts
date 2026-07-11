import { describe, it, expect, vi } from "vitest";
import worker from "./worker";

const SHELL = `<!doctype html><html><head><meta charset="UTF-8"/><title>AgentGem</title></head><body><div id="root"></div></body></html>`;

// env whose ASSETS always returns the SPA shell; fetch (for game-meta) is stubbed per test.
function env(over: Partial<{ AGGREGATOR_API: string }> = {}) {
  return { ASSETS: { fetch: vi.fn(async () => new Response(SHELL, { headers: { "content-type": "text/html" } })) }, AGGREGATOR_API: "https://api.test", ...over };
}
const req = (path: string, method = "GET") => new Request(`https://app.agentgem.ai${path}`, { method });

describe("marketplace OG worker", () => {
  it("injects og:title/description into the shell for a /games/<key> with a known game", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ title: "Tetris", genre: "project-fun", version: "1" }), { status: 200 })));
    const res = await worker.fetch(req("/games/@acme/tetris"), env());
    const html = await res.text();
    expect(html).toContain(`<meta property="og:title" content="Tetris">`);
    expect(html).toContain(`<meta name="twitter:card" content="summary">`);
    expect(html).toContain(`<meta property="og:url" content="https://app.agentgem.ai/games/@acme/tetris">`);
    expect(html).not.toContain("og:image");            // summary card, no image
    expect(html).toContain(`<div id="root"></div>`);   // full SPA body preserved
  });

  it("escapes a title containing \" and <", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ title: `A"B<C`, genre: "project-fun", version: "1" }), { status: 200 })));
    const html = await (await worker.fetch(req("/games/x"), env())).text();
    expect(html).toContain(`content="A&quot;B&lt;C"`);
    expect(html).not.toContain(`content="A"B<C"`);
  });

  it("serves the shell UNMODIFIED when game-meta 404s (unknown key)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const html = await (await worker.fetch(req("/games/nope"), env())).text();
    expect(html).toBe(SHELL);
  });

  it("serves the shell UNMODIFIED when game-meta fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    const html = await (await worker.fetch(req("/games/x"), env())).text();
    expect(html).toBe(SHELL);
  });

  it("serves UNMODIFIED (no meta fetch attempted) when AGGREGATOR_API is unset", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const e = env({ AGGREGATOR_API: undefined });
    const html = await (await worker.fetch(req("/games/x"), e)).text();
    expect(html).toBe(SHELL);
    expect(f).not.toHaveBeenCalled();                  // no meta call without a base
  });

  it("passes every non-/games request straight to env.ASSETS", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const e = env();
    await worker.fetch(req("/gems/@acme/foo"), e);
    await worker.fetch(req("/"), e);
    expect(e.ASSETS.fetch).toHaveBeenCalledTimes(2);
    expect(f).not.toHaveBeenCalled();                  // no game-meta call for non-games paths
  });

  it("passes a non-GET /games request through untouched (no injection)", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const e = env();
    const html = await (await worker.fetch(req("/games/x", "POST"), e)).text();
    expect(html).toBe(SHELL);
    expect(f).not.toHaveBeenCalled();
  });

  it("passes /manifest.webmanifest straight to ASSETS (no OG injection, no meta fetch)", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const e = env();
    const res = await worker.fetch(req("/manifest.webmanifest"), e);
    expect(e.ASSETS.fetch).toHaveBeenCalledOnce();     // delegated to static assets
    expect(f).not.toHaveBeenCalled();                  // no aggregator meta call
    expect(await res.text()).toBe(SHELL);              // returns exactly what ASSETS gave, unmodified
  });
});
