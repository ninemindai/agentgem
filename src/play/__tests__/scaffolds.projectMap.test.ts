// src/play/__tests__/scaffolds.projectMap.test.ts
import { describe, it, expect } from "vitest";
import { scaffoldFor, staticGate, assertPortable } from "@agentgem/play";

describe("project-map scaffold", () => {
  const html = () => scaffoldFor("project-map");

  it("passes the static gate untouched", () => {
    expect(staticGate(html())).toEqual({ ok: true, failures: [] });
  });

  it("reads its data from the game-data seam", () => {
    expect(html()).toContain('getElementById("game-data")');
  });

  it("declares local-project-access as an enhancement, so it needs no baked timeline", () => {
    expect(assertPortable(html(), ["local-project-access"])).toEqual({ ok: true, failures: [] });
  });

  it("calls the inventory tool with a literal name so needs-reconciliation can see it", () => {
    // A non-literal tool name is rejected outright by Save: the reconciler reads source text.
    expect(html()).toContain('callTool("agentgem_get_inventory"');
  });
});
