import { describe, it, expect } from "vitest";
import { scanSessions, type SourceSpec } from "@agentgem/insight";

describe("registry-driven scanSessions", () => {
  it("folds in a custom spec's sessions", async () => {
    const fake: SourceSpec = { id: "fake", label: "F", traits: { storage: "json" }, roots: () => ["r"],
      scanSessions: async () => [{ agent: "fake", sessionId: "s", project: null, model: null, gitBranch: null, startMs: 0, endMs: 1, msgs: 1, tokensIn: 1, tokensOut: 1, tokensCache: 0 }] };
    const stats = await scanSessions(undefined, [fake]);
    expect(stats.map((s) => s.agent)).toEqual(["fake"]);
  });
});
