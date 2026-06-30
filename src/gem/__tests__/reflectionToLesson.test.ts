// src/gem/__tests__/reflectionToLesson.test.ts
import { describe, it, expect } from "vitest";
import { reflectionToLesson, reflectionsToLessons, lessonSlug } from "@agentgem/insight";
import type { Reflection } from "@agentgem/insight";

const prov = (sessionIds: string[]) => ({
  occurrences: sessionIds.map((sessionId, i) => ({ sessionId, transcript: "t.jsonl", messageIndices: [i], atMs: 0 })),
});
const refl = (kind: Reflection["kind"], detail: string, sessionIds = ["s1"]): Reflection => ({
  kind, detail, importance: "high", provenance: prov(sessionIds),
});

describe("lessonSlug", () => {
  it("kebabs the leading words and caps length", () => {
    expect(lessonSlug("Always rebuild dist before running vitest because reasons here")).toBe("always-rebuild-dist-before-running-vitest");
  });
  it("falls back to 'lesson' for empty/symbol-only detail", () => {
    expect(lessonSlug("!!! ???")).toBe("lesson");
  });
});

describe("reflectionToLesson", () => {
  it("promotes a recurring-pattern to a draft lesson with sessions count + root", () => {
    const l = reflectionToLesson(refl("recurring-pattern", "Rebuild dist before vitest.", ["s1", "s2", "s1"]), "/repo");
    expect(l).not.toBeNull();
    expect(l!.status).toBe("draft");
    expect(l!.body).toBe("Rebuild dist before vitest.");
    expect(l!.importance).toBe("high");
    expect(l!.evidence.root).toBe("/repo");
    expect(l!.evidence.sessions).toBe(2); // distinct sessionIds
    expect(l!.name).toBe("rebuild-dist-before-vitest");
  });
  it("promotes a recurring-decision too", () => {
    expect(reflectionToLesson(refl("recurring-decision", "Prefer worktrees.", ["s1"]), "/r")).not.toBeNull();
  });
  it("excludes unresolved-task (returns null)", () => {
    expect(reflectionToLesson(refl("unresolved-task", "Finish the migration.", ["s1"]), "/r")).toBeNull();
  });
});

describe("reflectionsToLessons", () => {
  it("drops nulls and de-duplicates colliding names", () => {
    const ls = reflectionsToLessons([
      refl("recurring-pattern", "Same lesson text.", ["s1"]),
      refl("unresolved-task", "ignored", ["s1"]),
      refl("recurring-decision", "Same lesson text.", ["s2"]),
    ], "/r");
    expect(ls).toHaveLength(2);
    expect(ls.map((l) => l.name)).toEqual(["same-lesson-text", "same-lesson-text-2"]);
  });
});
