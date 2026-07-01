// src/gem/__tests__/cline.source.test.ts
import { describe, it, expect } from "vitest";
import { BUILTIN_SOURCES } from "@agentgem/insight";

describe("cline SourceSpec", () => {
  it("is registered with json storage and both faces", () => {
    const cline = BUILTIN_SOURCES.find((s) => s.id === "cline");
    expect(cline?.traits.storage).toBe("json");
    expect(typeof cline?.scanSessions).toBe("function");
    expect(typeof cline?.readArtifacts).toBe("function");
  });
  it("returns [] roots when no globalStorage exists (never throws)", async () => {
    const cline = BUILTIN_SOURCES.find((s) => s.id === "cline")!;
    await expect(cline.scanSessions!(cline.roots({ baseDir: "/no/such" }))).resolves.toEqual([]);
  });
});
