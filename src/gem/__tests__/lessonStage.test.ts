// src/gem/__tests__/lessonStage.test.ts
import { describe, it, expect } from "vitest";
import { distilledLessonMarkdown, lessonToArtifact } from "@agentgem/capture";
import type { DistilledLesson } from "@agentgem/insight";

const lesson: DistilledLesson = {
  name: "rebuild-dist-before-vitest",
  body: "Rebuild dist before running vitest, or stale compiled tests run.",
  importance: "high",
  status: "draft",
  evidence: { sessions: 3, root: "/r", provenance: { occurrences: [
    { sessionId: "secret-session-id", transcript: "t.jsonl", messageIndices: [4], atMs: 0 },
  ] } },
};

describe("distilledLessonMarkdown", () => {
  it("renders the lesson body + a sessions-count footer", () => {
    const md = distilledLessonMarkdown(lesson);
    expect(md).toContain("Rebuild dist before running vitest");
    expect(md).toContain("3 sessions");
    expect(md).toContain("importance: high");
  });
  it("never leaks raw provenance (no sessionId in content)", () => {
    expect(distilledLessonMarkdown(lesson)).not.toContain("secret-session-id");
  });
});

describe("lessonToArtifact", () => {
  it("produces an instructions artifact carrying the markdown", () => {
    const a = lessonToArtifact(lesson);
    expect(a.type).toBe("instructions");
    expect(a.name).toBe("rebuild-dist-before-vitest");
    expect(a.content).toContain("Rebuild dist before running vitest");
  });
});

import { writeDistilledLesson, stageDistilledLessons, stageLessonsByEvidence } from "@agentgem/capture";
import { buildGem } from "@agentgem/build";
import type { ConfigInventory } from "@agentgem/model";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function emptyInv(): ConfigInventory {
  return {
    skills: [], mcpServers: [], instructions: [], hooks: [],
    projects: [{ root: "/r", name: "app", skills: [], mcpServers: [], instructions: [], hooks: [] }],
  };
}
const at = (root: string): DistilledLesson => ({ ...lesson, evidence: { ...lesson.evidence, root } });

describe("stageDistilledLessons", () => {
  it("stages a lesson so buildGem includes it as an instructions artifact", () => {
    const staged = stageDistilledLessons(emptyInv(), [at("/r")], "/r");
    const gem = buildGem(staged, { projects: { "/r": { includeInstructions: true } } });
    const art = gem.artifacts.find((a) => a.name === "rebuild-dist-before-vitest");
    expect(art?.type).toBe("instructions");
  });
  it("does not mutate the input inventory", () => {
    const inv = emptyInv();
    stageDistilledLessons(inv, [at("/r")], "/r");
    expect(inv.projects![0].instructions).toHaveLength(0);
  });
  it("is a no-op (same ref) for an empty list", () => {
    const inv = emptyInv();
    expect(stageDistilledLessons(inv, [], "/r")).toBe(inv);
  });
});

describe("stageLessonsByEvidence", () => {
  it("routes each lesson to its evidence.root", () => {
    const staged = stageLessonsByEvidence(emptyInv(), [at("/r")]);
    expect(staged.projects![0].instructions).toHaveLength(1);
  });
});

describe("writeDistilledLesson", () => {
  it("writes .agentgem/distilled/lessons/<name>.md and returns the path", () => {
    const base = mkdtempSync(join(tmpdir(), "lessonw-"));
    const path = writeDistilledLesson(at("/r"), base);
    expect(path).toBe(join(base, ".agentgem", "distilled", "lessons", "rebuild-dist-before-vitest.md"));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("Rebuild dist before running vitest");
  });
});
