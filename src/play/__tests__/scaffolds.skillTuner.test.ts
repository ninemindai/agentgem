// src/play/__tests__/scaffolds.skillTuner.test.ts
import { describe, it, expect } from "vitest";
import { scaffoldFor, staticGate, assertPortable, deriveNeeds } from "@agentgem/play";

describe("skill-tuner scaffold", () => {
  const html = () => scaffoldFor("skill-tuner");

  it("passes the static gate untouched", () => {
    expect(staticGate(html())).toEqual({ ok: true, failures: [] });
  });

  it("derives copy-command from a literal method call", () => {
    // Save derives needs from source text; an aliased reference would be pruned and then fail at play time.
    expect(deriveNeeds(html())).toContain("copy-command");
  });

  it("needs no baked timeline: copy-command is an enhancement, not content", () => {
    expect(assertPortable(html(), ["copy-command"])).toEqual({ ok: true, failures: [] });
  });

  it("renders the skill readout before any host call, so it is useful with no clipboard", () => {
    expect(html()).toContain('getElementById("game-data")');
    expect(html()).toContain("render()");
  });
});
