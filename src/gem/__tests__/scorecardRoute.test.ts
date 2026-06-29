// src/gem/__tests__/scorecardRoute.test.ts
import { describe, it, expect } from "vitest";
import { GemController } from "../../gem.controller.js";

describe("GET /api/scorecard handler", () => {
  it("returns a count-only scorecard shape for the given projects", async () => {
    const ctrl = new GemController();
    const res = await ctrl.scorecard({ query: { projects: JSON.stringify([process.cwd()]) } as any });
    expect(res).toHaveProperty("breadth");
    expect(res).toHaveProperty("battleTested");
    expect(res).toHaveProperty("portable");
    expect(Array.isArray(res.projects)).toBe(true);
    expect(typeof res.generatedAtMs).toBe("number");
    // Count-only guarantee: no dollar/value field leaks into the payload.
    expect(JSON.stringify(res)).not.toMatch(/\$|latentValue|dollars/);
  });
});
