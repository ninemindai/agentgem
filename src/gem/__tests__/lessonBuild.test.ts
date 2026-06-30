// src/gem/__tests__/lessonBuild.test.ts
import { describe, it, expect } from "vitest";
import { DistilledLessonSchema, GemRequestSchema } from "../../schemas.js";

describe("DistilledLessonSchema", () => {
  it("accepts a valid lesson and rejects a bad importance", () => {
    const ok = { name: "x", body: "b", importance: "high", status: "draft",
      evidence: { sessions: 1, root: "/r", provenance: { occurrences: [] } } };
    expect(DistilledLessonSchema.safeParse(ok).success).toBe(true);
    expect(DistilledLessonSchema.safeParse({ ...ok, importance: "low" }).success).toBe(false);
    expect(DistilledLessonSchema.safeParse({ ...ok, status: "installed" }).success).toBe(false);
  });
  it("is wired into GemRequestSchema as an optional array (shape key present)", () => {
    // The field-threading itself is guarded by tsc (the controller reads
    // input.body.distilledLessons) + Task 3's staging proof; here we only assert
    // the key exists on the request schema so a regression that drops it is caught.
    expect(Object.keys((GemRequestSchema as unknown as { shape: Record<string, unknown> }).shape))
      .toContain("distilledLessons");
  });
});
