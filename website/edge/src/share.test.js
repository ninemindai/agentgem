import { describe, it, expect } from "vitest";
import { parseShareId, renderShareHtml, handleShare, isCacheable, renderGemShareHtml } from "./share.js";

const record = { kind: "certificate", counts: { breadth: 14, battleTested: 3, portable: 5 }, generatedAtMs: 1, createdAtMs: 2 };

describe("parseShareId", () => {
  it("parses card + og.png paths and rejects others", () => {
    expect(parseShareId("/share/abc123")).toEqual({ id: "abc123", png: false });
    expect(parseShareId("/share/abc123/og.png")).toEqual({ id: "abc123", png: true });
    expect(parseShareId("/")).toBeNull();
    expect(parseShareId("/share/")).toBeNull();
    expect(parseShareId("/share/abc/extra")).toBeNull();
  });
});

describe("renderShareHtml", () => {
  it("emits OG/Twitter meta with canonical image + escaped description", () => {
    const html = renderShareHtml(record, { ogImageUrl: "https://agentgem.ai/share/x/og.png", shareUrl: "https://agentgem.ai/share/x" });
    expect(html).toContain('<meta property="og:title" content="My Agent Goldmine">');
    expect(html).toContain('<meta property="og:image" content="https://agentgem.ai/share/x/og.png">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain("14 reusable workflows · 3 battle-tested · 5 worth sharing");
    expect(html).toContain("agentgem.ai"); // invite CTA target
  });
});

describe("handleShare", () => {
  const env = { AGGREGATOR_API: "https://api.test" };

  it("returns null for non-share paths", async () => {
    expect(await handleShare(new Request("https://agentgem.ai/docs"), env)).toBeNull();
  });

  it("renders HTML for a known id", async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => record });
    const res = await handleShare(new Request("https://agentgem.ai/share/x"), { ...env, fetch: fetchImpl });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("404s an unknown id", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const res = await handleShare(new Request("https://agentgem.ai/share/missing"), { ...env, fetch: fetchImpl });
    expect(res.status).toBe(404);
  });

  it("serves a graceful placeholder when AGGREGATOR_API is unset", async () => {
    const res = await handleShare(new Request("https://agentgem.ai/share/x"), {});
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("coming soon");
  });
});

describe("gem unfurl", () => {
  it("is a text summary card (no og:image)", () => {
    const html = renderGemShareHtml({ kind: "gem", name: "my-wf", provenance: "Distilled from 5 sessions" }, { shareUrl: "https://agentgem.ai/share/g" });
    expect(html).toContain('<meta property="og:title" content="my-wf">');
    expect(html).toContain('<meta property="og:description" content="Distilled from 5 sessions">');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).not.toContain("og:image");
    expect(html).toContain("agentgem.ai");
  });
  it("handleShare routes a gem record to the gem unfurl, og.png 404s", async () => {
    const rec = { kind: "gem", name: "my-wf", provenance: "Distilled from 5 sessions", generatedAtMs: 1, createdAtMs: 2 };
    const env = { AGGREGATOR_API: "https://api.test", fetch: async () => ({ ok: true, json: async () => rec }) };
    const page = await handleShare(new Request("https://agentgem.ai/share/g"), env);
    expect(await page.text()).toContain("twitter:card");
    const png = await handleShare(new Request("https://agentgem.ai/share/g/og.png"), env);
    expect(png.status).toBe(404);
  });
});

describe("isCacheable", () => {
  it("is true for responses with a Cache-Control header (HTML / og.png)", () => {
    expect(isCacheable(new Response("x", { headers: { "cache-control": "public, max-age=300" } }))).toBe(true);
    expect(isCacheable(new Response("x", { headers: { "cache-control": "public, max-age=31536000, immutable" } }))).toBe(true);
  });
  it("is false for the placeholder, the 404, and null (no Cache-Control)", () => {
    expect(isCacheable(new Response("coming soon", { headers: { "content-type": "text/html" } }))).toBe(false);
    expect(isCacheable(new Response("Card not found", { status: 404, headers: { "content-type": "text/plain" } }))).toBe(false);
    expect(isCacheable(null)).toBe(false);
  });
});
