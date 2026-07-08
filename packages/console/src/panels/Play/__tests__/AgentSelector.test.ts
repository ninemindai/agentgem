import { describe, expect, it } from "vitest";
import { discoveredAgentsFromSessions, mergeRunnableAndDiscoveredAgents, preferredAgentId } from "../AgentSelector.js";

describe("Play AgentSelector helpers", () => {
  it("discovers agents from session transcripts and maps Claude/Codex to runnable adapters", () => {
    const discovered = discoveredAgentsFromSessions([
      { agent: "claude" },
      { agent: "codex" },
      { agent: "codex" },
      { agent: "gemini" },
    ]);
    const merged = mergeRunnableAndDiscoveredAgents([
      { id: "claude-code", name: "Claude Code", available: true },
      { id: "codex", name: "Codex", available: true },
    ], discovered);

    expect(merged.find((a) => a.id === "codex")).toMatchObject({ available: true, seenInSessions: 2, discoveredIds: ["codex"] });
    expect(merged.find((a) => a.id === "claude-code")).toMatchObject({ available: true, seenInSessions: 1, discoveredIds: ["claude"] });
    expect(merged.find((a) => a.id === "gemini")).toMatchObject({ available: false, seenInSessions: 1, name: "Gemini CLI" });
  });

  it("prefers an available agent seen in transcripts, with Codex first when seen", () => {
    expect(preferredAgentId([
      { id: "claude-code", name: "Claude Code", available: true, seenInSessions: 3 },
      { id: "codex", name: "Codex", available: true, seenInSessions: 1 },
    ])).toBe("codex");

    expect(preferredAgentId([
      { id: "gemini", name: "Gemini CLI", available: false, seenInSessions: 5 },
      { id: "claude-code", name: "Claude Code", available: true },
    ])).toBe("claude-code");
  });
});
