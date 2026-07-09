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

// Resolution of issue #243 finding B: LoopSpecSchema is a TOLERANT read gate, matching
// sanitizeLoop (packages/archive/src/archive.ts). A wrong-shaped optional sub-field is dropped
// and the valid core preserved; a malformed required field (mode / guardrails.approval) drops the
// whole loop but keeps the enclosing gem — it never hard-rejects the gem. These tests pin that
// agreement so a future refactor can't silently flip either layer back to strict rejection.
describe("GemManifestSchema loop tolerance (issue #243 finding B)", () => {
  it("drops a wrong-shaped guardrail sub-field but keeps the valid loop core", () => {
    const parsed = GemManifestSchema.parse({
      ...manifestBase,
      loop: {
        mode: "loop",
        schedule: { kind: "interval", everyMs: 3600000 },
        guardrails: { approval: "gate", maxRounds: "lots" },
      },
    });
    expect(parsed.loop?.mode).toBe("loop");
    expect(parsed.loop?.guardrails.approval).toBe("gate");
    expect(parsed.loop?.schedule?.everyMs).toBe(3600000);
    expect(parsed.loop?.guardrails.maxRounds).toBeUndefined();
  });

  it("drops a wrong-shaped goal sub-field but keeps the rest of the goal", () => {
    const parsed = GemManifestSchema.parse({
      ...manifestBase,
      loop: {
        mode: "goal",
        goal: { until: "inbox clear", check: "regex", pattern: 42 },
        guardrails: { approval: "auto" },
      },
    });
    expect(parsed.loop?.goal?.until).toBe("inbox clear");
    expect(parsed.loop?.goal?.check).toBe("regex");
    expect(parsed.loop?.goal?.pattern).toBeUndefined();
  });

  it("drops the whole loop (not the gem) when the required mode is malformed", () => {
    const parsed = GemManifestSchema.parse({
      ...manifestBase,
      loop: { mode: "sideways", guardrails: { approval: "gate" } },
    });
    expect(parsed.loop).toBeUndefined();
    expect(parsed.name).toBe("l-gem"); // the gem itself survives
  });

  it("drops the whole loop when the required guardrails.approval is malformed", () => {
    const parsed = GemManifestSchema.parse({
      ...manifestBase,
      loop: { mode: "loop", guardrails: { approval: "maybe" } },
    });
    expect(parsed.loop).toBeUndefined();
  });
});
