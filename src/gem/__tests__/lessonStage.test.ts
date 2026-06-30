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
