// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import type { GemArtifact, RubricArtifact } from "@agentgem/model";

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
