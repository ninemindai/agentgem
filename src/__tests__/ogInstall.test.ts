import { describe, it, expect, vi, afterEach } from "vitest";
import { cardImageUrl, renderCardResponse, renderEntityHtml, installOg } from "../og/install.js";
import type { OgMeta } from "../og/meta.js";

// installOg wires its GetMeta to buildOgMeta(db, card) internally, so the entity-middleware test
// below stubs that module rather than injecting a getMeta directly.
vi.mock("../og/meta.js", () => ({
  buildOgMeta: vi.fn(async (): Promise<OgMeta> => ({ title: "Pizza", description: "Play on AgentGem", imageUrl: null })),
}));

const SHELL = `<!doctype html><html><head><title>AgentGem</title></head><body><div id="root"></div></body></html>`;
const fakeFetch = ((_url: string) => Promise.resolve(new Response(SHELL, { status: 200 }))) as unknown as typeof fetch;

describe("cardImageUrl", () => {
  it("builds an identity-driven card URL with an encoded key", () => {
    expect(cardImageUrl("https://app.agentgem.ai", { type: "game", key: "@acme/x" }))
      .toBe("https://app.agentgem.ai/og/card.png?type=game&key=%40acme%2Fx");
  });
});

describe("renderCardResponse", () => {
  it("renders a PNG when meta resolves", async () => {
    const png = await renderCardResponse(async () => ({ title: "Pizza", description: "Play on AgentGem", imageUrl: null }),
      { type: "game", key: "@acme/pizza" });
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
  it("renders the placeholder PNG when meta is null", async () => {
    const png = await renderCardResponse(async () => null, { type: "gem", key: "nope" });
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("renderEntityHtml", () => {
  const base = { assetOrigin: "https://assets.example", ogImageOrigin: "https://app.agentgem.ai", fetchImpl: fakeFetch };

  it("injects a card and points og:image at the identity card URL", async () => {
    const html = await renderEntityHtml({ ...base, getMeta: async (): Promise<OgMeta> => ({ title: "Pizza", description: "Play on AgentGem", imageUrl: null }) },
      "/games/@acme/pizza", "https://app.agentgem.ai/games/@acme/pizza");
    expect(html).toContain("<title>Pizza — AgentGem</title>");
    expect(html).toContain(`content="https://app.agentgem.ai/og/card.png?type=game&amp;key=%40acme%2Fpizza"`);
    expect(html).toContain("summary_large_image");
  });

  it("returns null for a non-entity path (caller serves the plain asset)", async () => {
    const html = await renderEntityHtml({ ...base, getMeta: async () => null }, "/api/whatever", "u");
    expect(html).toBeNull();
  });

  it("fails open (null) when meta is null", async () => {
    const html = await renderEntityHtml({ ...base, getMeta: async () => null }, "/games/@acme/x", "u");
    expect(html).toBeNull();
  });

  it("fails open (null) when the shell fetch is not ok", async () => {
    const bad = ((_u: string) => Promise.resolve(new Response("", { status: 502 }))) as unknown as typeof fetch;
    const html = await renderEntityHtml({ ...base, fetchImpl: bad, getMeta: async (): Promise<OgMeta> => ({ title: "P", description: "d", imageUrl: null }) },
      "/games/@acme/x", "u");
    expect(html).toBeNull();
  });
});

describe("installOg /og/card.png handler", () => {
  it("always responds — a request with a bad/missing type gets a 400, never hangs", async () => {
    let cardHandler: ((req: any, res: any) => void) | undefined;
    const fakeApp = {
      get(path: string, h: (req: any, res: any) => void) { if (path === "/og/card.png") cardHandler = h; },
      use() {},
    };
    installOg(fakeApp as never, { db: {} as never, assetOrigin: "https://x", ogImageOrigin: "https://x" });
    expect(cardHandler).toBeDefined();

    let statusCode = 0, done = false;
    const res: any = {
      set() { return res; },
      status(c: number) { statusCode = c; return res; },
      send() { done = true; },
      end() { done = true; },
    };
    cardHandler!({ query: {} }, res);
    await new Promise((r) => setImmediate(r)); // let the handler's async IIFE settle

    expect(statusCode).toBe(400);
    expect(done).toBe(true);
  });
});

describe("installOg entity middleware — og:url", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("builds og:url from the configured ogImageOrigin, not req.get('host')", async () => {
    globalThis.fetch = fakeFetch;

    let entityHandler: ((req: any, res: any, next: () => void) => void) | undefined;
    const fakeApp = {
      get() {},
      use(h: (req: any, res: any, next: () => void) => void) { entityHandler = h; },
    };
    installOg(fakeApp as never, { db: {} as never, assetOrigin: "https://assets.example", ogImageOrigin: "https://app.example" });
    expect(entityHandler).toBeDefined();

    let sent = "";
    const res: any = {
      set() { return res; },
      status() { return res; },
      send(b: string) { sent = b; },
      end() {},
    };
    const req = {
      method: "GET",
      path: "/games/@acme/pizza",
      originalUrl: "/games/@acme/pizza",
      query: {},
      protocol: "https",
      get(h: string) { return h === "host" ? "api.internal" : undefined; },
    };
    entityHandler!(req, res, () => {});
    await new Promise((r) => setImmediate(r)); // let the handler's async IIFE settle

    expect(sent).toContain('content="https://app.example/games/@acme/pizza"');
    expect(sent).not.toContain("api.internal");
  });
});
