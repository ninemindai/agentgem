import { describe, expect, it, beforeEach } from "vitest";
import {
  discoveredAgentsFromSessions,
  mergeRunnableAndDiscoveredAgents,
  preferredAgentId,
  lastAgentId,
  rememberAgentId,
} from "../AgentSelector.js";

describe("Play AgentSelector helpers", () => {
  beforeEach(() => localStorage.clear());

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

  it("lists Claude Code before Codex and defaults to it, from real merge output", () => {
    // Codex has more sessions, but the sort only tiers on *whether* an agent was seen, then
    // name — so this pins that the default is whatever the dropdown actually shows first.
    const agents = mergeRunnableAndDiscoveredAgents(
      [{ id: "codex", name: "Codex", available: true }, { id: "claude-code", name: "Claude Code", available: true }],
      discoveredAgentsFromSessions([{ agent: "codex" }, { agent: "codex" }, { agent: "claude" }]),
    );
    expect(agents.map((a) => a.id)).toEqual(["claude-code", "codex"]);
    expect(preferredAgentId(agents, lastAgentId())).toBe("claude-code");
  });

  it("defaults to the first available agent in list order, so the default is the option shown first", () => {
    // The merge sort already put these in display order; nothing re-ranks them here.
    expect(preferredAgentId([
      { id: "claude-code", name: "Claude Code", available: true, seenInSessions: 3 },
      { id: "codex", name: "Codex", available: true, seenInSessions: 1 },
    ])).toBe("claude-code");
  });

  it("skips agents that are not runnable, however many sessions they have", () => {
    expect(preferredAgentId([
      { id: "gemini", name: "Gemini CLI", available: false, seenInSessions: 5 },
      { id: "claude-code", name: "Claude Code", available: true },
    ])).toBe("claude-code");
  });

  it("has no answer when nothing is runnable", () => {
    expect(preferredAgentId([{ id: "gemini", name: "Gemini CLI", available: false }])).toBe("");
  });

  it("prefers what the user last picked over list order", () => {
    const agents = [
      { id: "claude-code", name: "Claude Code", available: true },
      { id: "codex", name: "Codex", available: true },
    ];
    expect(preferredAgentId(agents, "codex")).toBe("codex");
  });

  it("ignores a remembered agent that is no longer runnable", () => {
    const agents = [
      { id: "claude-code", name: "Claude Code", available: true },
      { id: "codex", name: "Codex", available: false },
    ];
    expect(preferredAgentId(agents, "codex")).toBe("claude-code");
    expect(preferredAgentId(agents, "gemini")).toBe("claude-code");
  });

  it("remembers the last picked agent across reloads", () => {
    expect(lastAgentId()).toBeNull();
    rememberAgentId("codex");
    expect(lastAgentId()).toBe("codex");
  });
});
