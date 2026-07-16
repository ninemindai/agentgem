import { describe, it, expect } from "vitest";
import { ObservePayloadSchema, SessionStatSchema } from "../gem.controller.js";
import { aggregateObserve, type SessionStat } from "@agentgem/insight";

// Drift-guard: the server's schema copies are the OpenAPI contract. This test makes
// the "aggregate grows a field the contract doesn't know" class unreproducible.
const stat: SessionStat = {
  agent: "claude", sessionId: "s1", project: "p", cwd: "/tmp/p", model: "m", gitBranch: null,
  startMs: 1000, endMs: 2000, msgs: 5, tokensIn: 10, tokensOut: 5, tokensCache: 2,
  tools: { Read: 3 }, skills: { verify: 1 }, subagents: { Explore: 1 },
};

describe("observe payload contract drift-guard", () => {
  it("aggregateObserve output parses against the server ObservePayloadSchema", () => {
    const parsed = ObservePayloadSchema.safeParse(aggregateObserve([stat], "all", 3000));
    expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues)).toBe(true);
  });

  it("insight SessionStat parses against the server SessionStatSchema (raw contract)", () => {
    const parsed = SessionStatSchema.safeParse(stat);
    expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues)).toBe(true);
  });
});
