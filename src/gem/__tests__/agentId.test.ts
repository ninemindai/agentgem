// src/gem/__tests__/agentId.test.ts
import { describe, it, expect } from "vitest";
import type { AgentId, SessionStat } from "@agentgem/insight";
import { canonicalHarness } from "@agentgem/model";

describe("AgentId is open", () => {
  it("accepts a non-builtin agent on SessionStat", () => {
    const id: AgentId = "cline";
    const s: SessionStat = { agent: id, sessionId: "t", project: null, model: null, gitBranch: null, startMs: 0, endMs: 1, msgs: 1, tokensIn: 0, tokensOut: 0, tokensCache: 0 };
    expect(s.agent).toBe("cline");
  });
  it("canonicalHarness maps known ids and passes through new ones", () => {
    expect(canonicalHarness("claude")).toEqual({ id: "claude-code", idKind: "known", public: true });
    expect(canonicalHarness("codex")).toEqual({ id: "codex", idKind: "known", public: true });
    expect(canonicalHarness("cline")).toEqual({ id: "cline", idKind: "known", public: true });
  });
});
