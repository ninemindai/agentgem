import { describe, it, expect } from "vitest";
import { DiscoverPayloadSchema } from "../../gem.controller.js";
import { buildDiscover, type RegistrySkill } from "@agentgem/insight";

describe("DiscoverPayload contract", () => {
  it("accepts a real buildDiscover payload", async () => {
    const search = (async () => ([{ id: "a/b/x", skillId: "x", name: "x", source: "a/b", installs: 5 }] as RegistrySkill[])) as never;
    const usage = new Map([["skill:t", { type: "skill" as const, name: "t", root: null, invocations: 3, sessionsUsedIn: 1, lastUsedMs: 1, confidence: "high" as const }]]);
    const payload = await buildDiscover(usage, { skills: [], mcpServers: [], instructions: [], hooks: [] }, { search });
    expect(() => DiscoverPayloadSchema.parse(payload)).not.toThrow();
  });

  it("accepts a degraded payload", () => {
    expect(() => DiscoverPayloadSchema.parse({ candidates: [], topics: [], reranked: false, degraded: { reason: "offline" } })).not.toThrow();
  });
});
