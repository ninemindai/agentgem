// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import type { GemArtifact, RubricArtifact } from "@agentgem/model";
import { rubricToArtifact, artifactToRubric, builtinRubrics, type Rubric } from "@agentgem/insight";

const hygiene: RubricArtifact = {
  type: "rubric",
  name: "hygiene",
  title: "Session hygiene",
  target: "overview",
  naturalScope: "project",
  factors: [{ factor: "retry-storm" }, { factor: "thrash-loop", weight: 2 }],
};

describe("RubricArtifact type", () => {
  it("is a member of the GemArtifact union", () => {
    const artifacts: GemArtifact[] = [hygiene];
    expect(artifacts[0].type).toBe("rubric");
  });
});

describe("rubric <-> artifact adapters", () => {
  it("round-trips every built-in rubric", () => {
    for (const r of builtinRubrics()) {
      expect(artifactToRubric(rubricToArtifact(r))).toEqual(r);
    }
  });

  it("maps id<->name and preserves criteria", () => {
    const r: Rubric = {
      id: "with-crit",
      title: "With criteria",
      target: "overview",
      factors: [{ factor: "c1", weight: 3 }],
      criteria: [{ id: "c1", title: "T", question: "Q?", advice: "A", granularity: "aggregate" }],
    };
    const a = rubricToArtifact(r);
    expect(a.name).toBe("with-crit");
    expect(a.title).toBe("With criteria");
    expect(artifactToRubric(a)).toEqual(r);
  });
});
