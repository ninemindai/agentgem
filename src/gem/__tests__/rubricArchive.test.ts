// src/gem/__tests__/rubricArchive.test.ts
import { describe, it, expect } from "vitest";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";
import type { Gem, RubricArtifact } from "@agentgem/model";

const rubric: RubricArtifact = {
  type: "rubric",
  name: "context-hygiene",
  title: "Context hygiene",
  target: "overview",
  naturalScope: "all",
  factors: [{ factor: "task-sprawl" }, { factor: "reread-churn", weight: 2 }],
  criteria: [{ id: "deep", title: "Deep", question: "Deep review?", advice: "Do it", severity: "warn" }],
};

const gem: Gem = {
  name: "hygiene-pack",
  createdFrom: "test",
  artifacts: [rubric],
  checks: [],
  requiredSecrets: [],
};

describe("rubric archive round-trip", () => {
  it("writes and reads a rubric artifact unchanged", () => {
    const { files } = writeGemArchive(gem);
    expect("rubrics/context-hygiene.json" in files).toBe(true);
    const back = readGemArchive(files);
    expect(back.artifacts).toEqual([rubric]);
  });
});
