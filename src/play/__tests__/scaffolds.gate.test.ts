// src/play/__tests__/scaffolds.gate.test.ts
import { describe, it, expect } from "vitest";
import { scaffoldFor, gameGate } from "@agentgem/play";

const IDS = ["replay", "skill-run", "project-fun", "heatmap"];
describe("scaffolds pass the gate", () => {
  for (const id of IDS) {
    it(`${id} loads sealed`, async () => {
      const r = await gameGate(scaffoldFor(id));
      expect(r.ok, r.failures.join("; ")).toBe(true);
    });
  }
});
