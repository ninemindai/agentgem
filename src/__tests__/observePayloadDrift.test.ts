import { describe, it, expect } from "vitest";
import { ObservePayloadSchema, SessionStatSchema } from "@agentgem/app/gem.controller";
import { aggregateObserve, type SessionStat } from "@agentgem/insight";

// Drift-guard: the server's schema copies are the OpenAPI contract. z.object() STRIPS
// unknown keys instead of rejecting them, so a bare safeParse().success check can't
// catch "aggregate grew a field the schema doesn't know" — the direction that actually
// bit historically. The key-set comparison below is what catches that: if the parsed
// output is missing a key present on the input, the schema silently stripped it.
const stat: SessionStat = {
  agent: "claude", sessionId: "s1", project: "p", cwd: "/tmp/p", model: "m", gitBranch: null,
  startMs: 1000, endMs: 2000, msgs: 5, tokensIn: 10, tokensOut: 5, tokensCache: 2,
  tools: { Read: 3 }, skills: { verify: 1 }, subagents: { Explore: 1 },
};

describe("observe payload contract drift-guard", () => {
  it("aggregateObserve output parses against the server ObservePayloadSchema", () => {
    const payload = aggregateObserve([stat], "all", 3000);
    const parsed = ObservePayloadSchema.safeParse(payload);
    expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues)).toBe(true);
    if (parsed.success) expect(Object.keys(parsed.data).sort()).toEqual(Object.keys(payload).sort());
  });

  it("insight SessionStat parses against the server SessionStatSchema (raw contract)", () => {
    const parsed = SessionStatSchema.safeParse(stat);
    expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues)).toBe(true);
    if (parsed.success) expect(Object.keys(parsed.data).sort()).toEqual(Object.keys(stat).sort());
  });
});
