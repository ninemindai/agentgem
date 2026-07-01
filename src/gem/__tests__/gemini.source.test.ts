// src/gem/__tests__/gemini.source.test.ts
import { describe, it, expect } from "vitest";
import { BUILTIN_SOURCES } from "@agentgem/insight";

describe("gemini SourceSpec", () => {
  it("is registered with jsonl storage and a scan face", () => {
    const g = BUILTIN_SOURCES.find((s) => s.id === "gemini");
    expect(g?.traits.storage).toBe("jsonl");
    expect(typeof g?.scanSessions).toBe("function");
    expect(typeof g?.readArtifacts).toBe("function");
  });
  it("absent ~/.gemini yields [] sessions, never throws", async () => {
    const g = BUILTIN_SOURCES.find((s) => s.id === "gemini")!;
    await expect(g.scanSessions!(g.roots({ baseDir: "/no/such" }))).resolves.toEqual([]);
  });
});
