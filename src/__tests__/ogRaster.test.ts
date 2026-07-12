import { describe, it, expect } from "vitest";
import { renderCardPng } from "../og/raster.js";
import { renderCardSvg } from "../og/card.js";

describe("renderCardPng", () => {
  it("rasterizes a card SVG to a PNG", async () => {
    const png = await renderCardPng(renderCardSvg({ type: "game", title: "Pizza Panic", subtitle: "Play on AgentGem" }));
    // PNG magic bytes: 89 50 4E 47
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.length).toBeGreaterThan(1000);
  });
});
