import { describe, it, expect } from "vitest";
import { writeGemArchive, readGemArchive, computeLock } from "@agentgem/archive";
import type { Gem, LoopSpec } from "@agentgem/model";

const loop: LoopSpec = {
  mode: "loop",
  schedule: { kind: "interval", everyMs: 3_600_000 },
  guardrails: { approval: "gate", maxRounds: 1 },
};

describe("LoopSpec type", () => {
  it("attaches to a Gem as an optional facet", () => {
    const gem: Gem = {
      name: "inbox-triage",
      createdFrom: "test",
      artifacts: [{ type: "skill", name: "triage", source: "standalone", content: "# Triage" }],
      checks: [],
      requiredSecrets: [],
      loop,
    };
    expect(gem.loop?.mode).toBe("loop");
    expect(gem.loop?.guardrails.approval).toBe("gate");
  });
});

const base: Gem = {
  name: "l-gem",
  createdFrom: "test",
  artifacts: [{ type: "skill", name: "triage", source: "standalone", content: "# Triage" }],
  checks: [],
  requiredSecrets: [],
};

describe("archive round-trip of the loop facet", () => {
  it("preserves a loop through write → read", () => {
    const gem: Gem = { ...base, loop };
    const { files } = writeGemArchive(gem);
    expect(JSON.parse(files["gem.json"]).loop.mode).toBe("loop");
    expect(readGemArchive(files).loop).toEqual(loop);
  });

  it("a gem without a loop reads back without one", () => {
    const { files } = writeGemArchive(base);
    expect("loop" in JSON.parse(files["gem.json"])).toBe(false);
    expect(readGemArchive(files).loop).toBeUndefined();
  });

  it("treats a malformed manifest loop as absent (tolerant reader)", () => {
    const { files } = writeGemArchive(base);
    const manifest = JSON.parse(files["gem.json"]);
    manifest.loop = { mode: "sideways", guardrails: 42 }; // wrong shapes
    files["gem.json"] = JSON.stringify(manifest, null, 2);
    files["gem.lock"] = JSON.stringify(computeLock(files), null, 2); // keep the lock honest
    expect(readGemArchive(files).loop).toBeUndefined();
  });

  it("drops only invalid optional sub-fields, keeping a valid core", () => {
    const { files } = writeGemArchive(base);
    const manifest = JSON.parse(files["gem.json"]);
    manifest.loop = {
      mode: "goal",
      guardrails: { approval: "gate", maxRounds: "lots" }, // maxRounds wrong type → dropped
      goal: { until: "done", check: "llm" },
    };
    files["gem.json"] = JSON.stringify(manifest, null, 2);
    files["gem.lock"] = JSON.stringify(computeLock(files), null, 2);
    expect(readGemArchive(files).loop).toEqual({
      mode: "goal",
      guardrails: { approval: "gate" },
      goal: { until: "done", check: "llm" },
    });
  });
});
