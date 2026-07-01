// src/gem/__tests__/bindings.test.ts
import { describe, it, expect } from "vitest";
import type { Gem, AgentBinding } from "@agentgem/model";
import { writeGemArchive } from "@agentgem/archive";

const base: Gem = { name: "g", createdFrom: "test", artifacts: [{ type: "instructions", name: "i", content: "hi" }], checks: [], requiredSecrets: [] };

describe("AgentBinding overlay", () => {
  it("is an optional unsigned overlay — never changes the gem digest", () => {
    const binding: AgentBinding = { agent: "cline", origin: "imported", model: "claude-sonnet-5" };
    const withB: Gem = { ...base, bindings: [binding] };
    const a = writeGemArchive(base);
    const b = writeGemArchive(withB);
    const digest = (files: Record<string, string>) => JSON.parse(files["gem.lock"]).gemDigest;
    expect(digest(b.files)).toBe(digest(a.files));
  });
});
