// src/play/__tests__/scaffolds.test.ts
import { describe, it, expect } from "vitest";
import { scaffoldFor, gameGate, GENRES } from "@agentgem/play";

describe("scaffolds", () => {
  it("scaffoldFor throws on unknown", () => { expect(() => scaffoldFor("nope")).toThrow(/unknown scaffold/); });
  it("every genre's scaffold passes the gate empty (sealed + runs clean)", async () => {
    for (const g of Object.values(GENRES)) expect(await gameGate(scaffoldFor(g.scaffold))).toEqual({ ok: true, failures: [] });
  });
  it("scaffolds carry the agent-editable marker", () => { expect(scaffoldFor("replay")).toContain("AGENTGEM:GAME-LOGIC"); });
});
