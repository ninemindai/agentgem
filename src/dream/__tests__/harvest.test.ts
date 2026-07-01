// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/dream/__tests__/harvest.test.ts
import { describe, it, expect } from "vitest";
import { provenanceHash, slugFromReflection, harvestEntries, reflectionToLesson } from "../harvest.js";
import type { DistilledSkill, Reflection } from "@agentgem/insight";

const prov = { occurrences: [{ sessionId: "s1", transcript: "t.jsonl", messageIndices: [3, 4], atMs: 10 }] };
const skill: DistilledSkill = {
  name: "run-migrations", description: "apply db migrations", triggers: ["migrate"], tools: ["Bash"],
  mutating: true, body: "…", evidence: { sessions: 2, exampleSequence: [], root: "/p", provenance: prov },
  status: "draft", confidence: "high", origin: "llm",
};
const refl: Reflection = { kind: "recurring-decision", detail: "prefer pnpm over npm here", importance: "high", provenance: prov };

describe("dream harvest", () => {
  it("hashes provenance stably", () => {
    expect(provenanceHash(prov)).toBe(provenanceHash({ occurrences: [...prov.occurrences] }));
    expect(provenanceHash(prov)).toHaveLength(8);
  });

  it("maps a skill to a DEEP skill entry with a stable key", () => {
    const [e] = harvestEntries("/p", [skill], [], 100);
    expect(e.kind).toBe("skill");
    expect(e.key).toBe(`skill:/p:run-migrations:${provenanceHash(prov)}`);
    expect(e.summary).toBe("apply db migrations");
    expect(e.confidence).toBe("high");
    expect(e.firstSeenMs).toBe(100);
  });

  it("maps a reflection to a lesson entry with a synthesized name", () => {
    const [e] = harvestEntries("/p", [], [refl], 100);
    expect(e.kind).toBe("lesson");
    expect(e.name).toBe("recurring-decision-prefer-pnpm-over");
    expect(e.importance).toBe("high");
    expect(e.key).toBe(`lesson:/p:${e.name}:${provenanceHash(prov)}`);
  });

  it("converts a lesson entry back to a DistilledLesson", () => {
    const [e] = harvestEntries("/p", [], [refl], 100);
    const lesson = reflectionToLesson(e);
    expect(lesson).toMatchObject({ name: e.name, body: "prefer pnpm over npm here", importance: "high", status: "draft" });
    expect(lesson.evidence.root).toBe("/p");
  });
});
