// src/gem/__tests__/continue.source.test.ts
import { describe, it, expect } from "vitest";
import { BUILTIN_SOURCES } from "@agentgem/insight";

describe("continue SourceSpec", () => {
  it("is registered with json storage and both faces", () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "continue");
    expect(c?.traits.storage).toBe("json");
    expect(typeof c?.scanSessions).toBe("function");
    expect(typeof c?.readArtifacts).toBe("function");
  });
  it("absent ~/.continue yields [] sessions, never throws", async () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "continue")!;
    await expect(c.scanSessions!(c.roots({ baseDir: "/no/such" }))).resolves.toEqual([]);
  });
});
