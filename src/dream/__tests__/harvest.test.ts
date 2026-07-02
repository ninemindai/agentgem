// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/dream/__tests__/harvest.test.ts
import { describe, it, expect } from "vitest";
import { provenanceHash, slugFromReflection, harvestEntries, reflectionToLesson, opportunityEntries } from "../harvest.js";
import type { DistilledSkill, Reflection } from "@agentgem/insight";

const prov = { occurrences: [{ sessionId: "s1", transcript: "t.jsonl", messageIndices: [3, 4], atMs: 10 }] };
const skill: DistilledSkill = {
  name: "run-migrations", description: "apply db migrations", triggers: ["migrate"], tools: ["Bash"],
  mutating: true, body: "…", evidence: { sessions: 2, exampleSequence: [], root: "/p", provenance: prov },
  status: "draft", confidence: "high", origin: "llm",
};
const refl: Reflection = { kind: "recurring-decision", detail: "prefer pnpm over npm here", importance: "high", provenance: prov };

describe("dream harvest", () => {
  it("maps publish candidates to REM opportunity entries keyed by session id", () => {
    const [e] = opportunityEntries("/p", [{ sessionId: "sess-1", goal: "ship it", why: "clean success" }], 100);
    expect(e.kind).toBe("opportunity");
    expect(e.phase).toBe("REM");
    expect(e.key).toBe("opportunity:/p:sess-1"); // sessionId is the stable identity — no provenance hash
    expect(e.name).toBe("sess-1");
    expect(e.summary).toBe("ship it");
    expect(e.status).toBe("queued");
    expect(e.firstSeenMs).toBe(100);
  });

  it("hashes provenance stably regardless of occurrence order", () => {
    const a = { occurrences: [prov.occurrences[0], { sessionId: "s2", transcript: "u.jsonl", messageIndices: [1], atMs: 20 }] };
    const b = { occurrences: [a.occurrences[1], a.occurrences[0]] };
    expect(provenanceHash(a)).toBe(provenanceHash(b)); // order-independent
    expect(provenanceHash(a)).toHaveLength(8);
  });

  it("slugFromReflection is deterministic, path-safe, and bounded", () => {
    expect(slugFromReflection(refl)).toBe("recurring-decision-prefer-pnpm-over");
    expect(slugFromReflection({ ...refl, detail: "x".repeat(200) }).length).toBeLessThanOrEqual(45);
  });

  it("maps a skill to a DEEP queued skill entry with a stable key", () => {
    const [e] = harvestEntries("/p", [skill], [], 100);
    expect(e.kind).toBe("skill");
    expect(e.phase).toBe("DEEP");
    expect(e.status).toBe("queued");
    expect(e.key).toBe(`skill:/p:run-migrations:${provenanceHash(prov)}`);
    expect(e.summary).toBe("apply db migrations");
    expect(e.confidence).toBe("high");
    expect(e.firstSeenMs).toBe(100);
  });

  it("maps a reflection to a DEEP queued lesson entry with a synthesized name", () => {
    const [e] = harvestEntries("/p", [], [refl], 100);
    expect(e.kind).toBe("lesson");
    expect(e.phase).toBe("DEEP");
    expect(e.status).toBe("queued");
    expect(e.name).toBe("recurring-decision-prefer-pnpm-over");
    expect(e.importance).toBe("high");
    expect(e.key).toBe(`lesson:/p:${e.name}:${provenanceHash(prov)}`);
  });

  it("converts a reflection to a DistilledLesson with a distinct-session count", () => {
    const lesson = reflectionToLesson(refl, "/p");
    expect(lesson).toMatchObject({ name: slugFromReflection(refl), body: "prefer pnpm over npm here", importance: "high", status: "draft" });
    expect(lesson.evidence.root).toBe("/p");
    expect(lesson.evidence.sessions).toBe(1);
  });
});
