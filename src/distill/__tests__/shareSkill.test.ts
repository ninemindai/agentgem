// src/distill/__tests__/shareSkill.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("agentgem-share skill", () => {
  it("exists and forbids the word 'verified' for self-reported telemetry", () => {
    const md = readFileSync(join(process.cwd(), "assets/skills/agentgem-share/SKILL.md"), "utf8");
    expect(md).toContain("self-reported telemetry");
    expect(md.toLowerCase()).toContain("privacy gate");
    // Exact prohibition: must say attestation is NOT verified (not merely mention the word)
    expect(md).toContain('Never tell the\n  user their attestation is "verified."');
    // Exact prohibition: must refuse to inflate usage counts
    expect(md).toContain("asks to inflate usage, refuse");
  });
});
