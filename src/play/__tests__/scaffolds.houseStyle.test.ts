// src/play/__tests__/scaffolds.houseStyle.test.ts
import { describe, it, expect } from "vitest";
import { scaffoldFor, staticGate, assertPortable } from "@agentgem/play";
import { HOUSE_TOKEN_NAMES } from "@agentgem/model";

describe("heatmap scaffold on the shared house style", () => {
  const html = () => scaffoldFor("heatmap");

  it("passes the static gate untouched by the studio agent", () => {
    expect(staticGate(html())).toEqual({ ok: true, failures: [] });
  });

  it("binds every shared colour token", () => {
    for (const name of HOUSE_TOKEN_NAMES) {
      expect(`${name}:${html().includes(`${name}:`)}`).toBe(`${name}:true`);
    }
  });

  it("still resolves through the host variables", () => {
    expect(html()).toContain("var(--color-background-primary,");
  });

  it("keeps the game-data seam so a seeded bundle stays portable", () => {
    // session-heatmap declares session-data, a CONTENT capability: assertPortable fails Save unless a
    // non-empty timeline is baked. Seeding writes that block; the scaffold must not rename or drop it.
    const seeded = html().replace(
      "</head>",
      `<script id="game-data" type="application/json">{"timeline":[{"role":"user","tsMs":0,"text":"hi"}]}</script></head>`,
    );
    expect(assertPortable(seeded, ["session-data"])).toEqual({ ok: true, failures: [] });
  });
});
