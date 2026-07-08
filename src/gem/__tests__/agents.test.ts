import { describe, it, expect } from "vitest";
import { AGENTS, availableAgents } from "@agentgem/base";

describe("availableAgents", () => {
  it("marks agents present/absent via the probe", () => {
    const out = availableAgents({
      runtime: "cli", execPath: "/usr/bin/node", home: "/home/u",
      onPath: (bin) => bin === "claude-agent-acp", exists: () => false, readJson: () => ({}),
    });
    const claude = out.find((a) => a.id === "claude-code");
    const codex = out.find((a) => a.id === "codex");
    expect(claude?.available).toBe(true);
    expect(codex?.available).toBe(false);
  });
  it("registry includes claude and codex", () => {
    expect(AGENTS.map((a) => a.id).sort()).toEqual(["claude-code", "codex"]);
  });
});
