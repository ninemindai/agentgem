// src/pack/__tests__/checks.test.ts
import { describe, it, expect } from "vitest";
import { scaffoldChecks, RUNNER_REGISTRY } from "../checks.js";
import type { Pack } from "../types.js";

function pack(over: Partial<Pack> = {}): Pack {
  return { name: "p", createdFrom: "/d", artifacts: [], checks: [], requiredSecrets: [], ...over };
}

describe("scaffoldChecks", () => {
  it("drafts a behavioral check plus a skillspector security check when skills are present", () => {
    const p = pack({ artifacts: [{ type: "skill", name: "review", description: "Review code", source: "standalone", content: "x" }] });
    const checks = scaffoldChecks(p);
    const beh = checks.find((c) => c.kind === "behavioral");
    const ext = checks.find((c) => c.kind === "external");
    expect(beh).toBeTruthy();
    expect(beh!.kind === "behavioral" && beh!.assertions).toEqual([]); // stubs: operator fills
    expect(beh!.kind === "behavioral" && beh!.task).toContain("Review code");
    expect(ext && ext.kind === "external" && ext.runner).toBe("skillspector");
    expect(ext && ext.kind === "external" && ext.with).toEqual(RUNNER_REGISTRY.skillspector.defaultWith);
  });

  it("drafts only a behavioral check when the pack has no skills", () => {
    const p = pack({ artifacts: [{ type: "instructions", name: "CLAUDE.md", content: "x" }] });
    const checks = scaffoldChecks(p);
    expect(checks.map((c) => c.kind)).toEqual(["behavioral"]);
  });
});
