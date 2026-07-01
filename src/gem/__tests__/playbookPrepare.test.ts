// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { preparePlaybook } from "../playbookPrepareCore.js"; // pure core extracted below
import type { DistilledSkill, DistilledLesson } from "@agentgem/insight";

describe("preparePlaybook (core)", () => {
  it("persists distilled skills + lessons and returns their names", async () => {
    const skills: DistilledSkill[] = [{ name: "ship-loop", description: "d", triggers: ["t"], tools: ["Bash"], mutating: false, body: "x", evidence: { sessions: 2, exampleSequence: [], root: "/r", provenance: { occurrences: [] } }, status: "draft", confidence: "high", origin: "llm" }];
    const lessons: DistilledLesson[] = [{ name: "verify-first", body: "verify", importance: "high", status: "draft", evidence: { sessions: 1, root: "/r", provenance: { occurrences: [] } } }];
    const written: string[] = [];
    const r = await preparePlaybook({
      root: "/r",
      distill: async () => ({ skills, lessons, degraded: false }),
      persistSkill: (s) => { written.push(`skill:${s.name}`); },
      persistLesson: (l) => { written.push(`lesson:${l.name}`); },
    });
    expect(r).toEqual({ skills: ["ship-loop"], lessons: ["verify-first"], root: "/r", degraded: false });
    expect(written).toEqual(["skill:ship-loop", "lesson:verify-first"]);
  });

  it("propagates the degraded flag from the distill result", async () => {
    const r = await preparePlaybook({
      root: "/r",
      distill: async () => ({ skills: [], lessons: [], degraded: true }),
      persistSkill: () => {},
      persistLesson: () => {},
    });
    expect(r).toEqual({ skills: [], lessons: [], root: "/r", degraded: true });
  });
});
