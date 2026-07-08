import { describe, it, expect } from "vitest";
import { GemManifestSchema } from "../../schemas.js";

const manifestBase = {
  formatVersion: 1,
  name: "l-gem",
  version: "0.1.0",
  createdFrom: "test",
  artifacts: [],
  requiredSecrets: [],
  checks: [],
};

describe("GemManifestSchema loop field", () => {
  it("preserves a valid loop instead of stripping it", () => {
    const withLoop = {
      ...manifestBase,
      loop: { mode: "loop", schedule: { kind: "interval", everyMs: 3600000 }, guardrails: { approval: "gate" } },
    };
    const parsed = GemManifestSchema.parse(withLoop);
    expect(parsed.loop?.mode).toBe("loop");
    expect(parsed.loop?.guardrails.approval).toBe("gate");
  });

  it("accepts a manifest with no loop", () => {
    expect(GemManifestSchema.parse(manifestBase).loop).toBeUndefined();
  });
});
