import { describe, it, expect } from "vitest";
import { availableAgents } from "../agents.js";
import type { AdapterCtx } from "../adapters.js";

function ctx(onPathBins: string[], runtime: "cli" | "desktop" = "cli"): AdapterCtx {
  return {
    runtime, execPath: "/usr/bin/node", home: "/home/u",
    onPath: (b) => onPathBins.includes(b), exists: () => false, readJson: () => ({}),
  };
}

describe("availableAgents", () => {
  it("marks a missing CLI adapter installable", () => {
    const out = availableAgents(ctx(["claude-agent-acp"]));
    const codex = out.find((a) => a.id === "codex")!;
    expect(codex.available).toBe(false);
    expect(codex.installable).toBe(true);
    expect(codex.source).toBe("missing");
    const claude = out.find((a) => a.id === "claude-code")!;
    expect(claude.available).toBe(true);
    expect(claude.installable).toBe(false);
  });

  it("never marks a missing desktop adapter installable (no npm there)", () => {
    const codex = availableAgents(ctx([], "desktop")).find((a) => a.id === "codex")!;
    expect(codex.available).toBe(false);
    expect(codex.installable).toBe(false);
  });
});
