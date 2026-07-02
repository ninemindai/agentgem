// src/gem/__tests__/cursor.source.test.ts
import { describe, it, expect } from "vitest";
import { BUILTIN_SOURCES } from "@agentgem/insight";

describe("cursor SourceSpec", () => {
  it("is registered with sqlite storage and both faces", () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "cursor");
    expect(c?.traits.storage).toBe("sqlite");
    expect(typeof c?.scanSessions).toBe("function");
    expect(typeof c?.readArtifacts).toBe("function");
  });
  it("absent Cursor DB yields [] sessions, never throws", async () => {
    const c = BUILTIN_SOURCES.find((s) => s.id === "cursor")!;
    await expect(c.scanSessions!(c.roots({ baseDir: "/no/such" }))).resolves.toEqual([]);
  });
});
