// src/distill/__tests__/shareSkill.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("agentgem-share skill", () => {
  it("exists and forbids the word 'verified' for self-reported telemetry", () => {
    const md = readFileSync(join(process.cwd(), "assets/skills/agentgem-share/SKILL.md"), "utf8");
    expect(md).toContain("self-reported telemetry");
    expect(md.toLowerCase()).toContain("privacy gate");
    expect(md.toLowerCase()).toContain("verified");  // SKILL must address the "verified" prohibition
    expect(md.toLowerCase()).toContain("inflate");   // SKILL must address refusing to inflate counts
  });
});
