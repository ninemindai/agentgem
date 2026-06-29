import { describe, it, expect } from "vitest";
import { rasterizeCard } from "./raster.js";

describe("rasterizeCard", () => {
  it("renders a non-empty PNG (magic bytes) from counts", async () => {
    const png = await rasterizeCard({ breadth: 14, battleTested: 3, portable: 5 });
    expect(png).toBeInstanceOf(Uint8Array);
    expect(png.length).toBeGreaterThan(1000);
    // PNG signature: 0x89 'P' 'N' 'G'
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 20000);
});
