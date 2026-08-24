// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { fetchRemixSource, type RemixHttp } from "@agentgem/app/gem/remixSourceClient";

const ok = (body: unknown) => ({ status: 200, json: async () => body });
const httpFor = (meta: unknown, html: unknown = { html: "<x>" }): RemixHttp => async (url) =>
  url.includes("game-meta") ? ok(meta) : ok(html);

describe("fetchRemixSource", () => {
  it("returns title/genre/version/html when the creator allows remixing", async () => {
    const src = await fetchRemixSource({ key: "@bob/snake", endpoint: "http://agg", http: httpFor({ title: "Snake", genre: "project-fun", version: "1.2.0", allowRemix: true }) });
    expect(src).toEqual({ title: "Snake", genre: "project-fun", version: "1.2.0", html: "<x>" });
  });
  it("pins the version game-meta resolved (game-html is fetched with it)", async () => {
    const urls: string[] = [];
    const http: RemixHttp = async (url) => { urls.push(url); return url.includes("game-meta") ? ok({ title: "S", genre: "project-fun", version: "2.0.1", allowRemix: true }) : ok({ html: "<x>" }); };
    await fetchRemixSource({ key: "@bob/snake", endpoint: "http://agg", http });
    expect(urls[1]).toContain("version=2.0.1");
  });
  it("refuses when allowRemix is false", async () => {
    await expect(fetchRemixSource({ key: "@bob/snake", endpoint: "http://agg", http: httpFor({ title: "S", genre: "project-fun", version: "1.0.0", allowRemix: false }) }))
      .rejects.toThrow(/hasn't allowed remixing/);
  });
  it("fail-closed: refuses when allowRemix is absent (pre-remix aggregator)", async () => {
    await expect(fetchRemixSource({ key: "@bob/snake", endpoint: "http://agg", http: httpFor({ title: "S", genre: "project-fun", version: "1.0.0" }) }))
      .rejects.toThrow(/hasn't allowed remixing/);
  });
  it("maps a 404 to a clean not-available error", async () => {
    const http: RemixHttp = async () => ({ status: 404, json: async () => ({}) });
    await expect(fetchRemixSource({ key: "@bob/gone", endpoint: "http://agg", http }))
      .rejects.toThrow(/not available to remix/);
  });
});
