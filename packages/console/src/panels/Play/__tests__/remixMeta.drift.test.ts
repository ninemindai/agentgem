// packages/console/src/panels/Play/__tests__/remixMeta.drift.test.ts
// Drift guard for the remixOf lineage field: if either client schema drops it, the Studio's
// save echo would silently erase lineage on every save (routes.ts strips unknown keys).
import { describe, it, expect } from "vitest";
import { playMiniappRoute, playSaveRoute, playImportRoute } from "../../../api/routes.js";

const REMIX = { gemKey: "@bob/snake", version: "1.2.0" };
const meta = { title: "t", genre: "project-fun", createdFrom: { kind: "html", title: "t" }, engineVersion: "1", remixOf: REMIX };

describe("remixOf client-schema drift", () => {
  it("playMiniappRoute response keeps meta.remixOf", () => {
    const parsed = playMiniappRoute.schemas.response.parse({ name: "g", html: "<x>", meta });
    expect(parsed.meta.remixOf).toEqual(REMIX);
  });
  it("playSaveRoute body keeps meta.remixOf", () => {
    const parsed = playSaveRoute.schemas.body.parse({ name: "g", html: "<x>", meta });
    expect(parsed.meta.remixOf).toEqual(REMIX);
  });
  it("playImportRoute body keeps remixOf + genre", () => {
    const parsed = playImportRoute.schemas.body.parse({ title: "t", html: "<x>", remixOf: REMIX, genre: "skill-run" });
    expect(parsed.remixOf).toEqual(REMIX);
    expect(parsed.genre).toBe("skill-run");
  });
});
