// src/play/__tests__/scaffolds.test.ts
import { describe, it, expect } from "vitest";
import { scaffoldFor, gameGate, GENRES } from "@agentgem/play";

describe("scaffolds", () => {
  it("scaffoldFor throws on unknown", () => { expect(() => scaffoldFor("nope")).toThrow(/unknown scaffold/); });
  it("every genre's scaffold passes the gate empty (sealed + runs clean)", async () => {
    for (const g of Object.values(GENRES)) expect(await gameGate(scaffoldFor(g.scaffold))).toEqual({ ok: true, failures: [] });
  });
  it("scaffolds carry the agent-editable marker", () => { expect(scaffoldFor("replay")).toContain("AGENTGEM:GAME-LOGIC"); });
  it("the replay scaffold renders the session (reads game-data: meta + timeline)", () => {
    const html = scaffoldFor("replay");
    expect(html).toContain("game-data");
    expect(html).toContain("DATA.meta");
    expect(html).toContain("DATA.timeline");
    expect(html).toContain("tools");   // renders the tool-usage breakdown
  });
});
