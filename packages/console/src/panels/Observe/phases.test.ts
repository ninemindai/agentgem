import { describe, it, expect } from "vitest";
import { phasesOf } from "./phases.js";

const view = {
  sessionId: "s", agent: "claude", meta: {} as any,
  turns: [
    { id: "t0", role: "user", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 },
      spans: [{ kind: "message", role: "user", text: "do the thing" }] },
    { id: "t1", role: "assistant", tsMs: 1, tokens: { in: 0, out: 30, cache: 0 },
      spans: [{ kind: "tool_call", name: "Read", input: "x" }, { kind: "tool_call", name: "Skill", input: "y" }] },
  ],
} as any;

describe("phasesOf", () => {
  it("splits at user prompts and aggregates tools/skills", () => {
    const ps = phasesOf(view);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ label: "do the thing", turns: 1, out: 30, tools: ["Read", "Skill"], skills: 1, agents: 0 });
  });
});
