// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import type { ProcedureStep, SessionSequence, WorkflowSignal } from "@agentgem/insight";
import { stageOf, stageProfile } from "@agentgem/insight";

let mi = 0;
const step = (verb: string, arg: string, tool = verb.startsWith("Bash:") ? "Bash" : verb): ProcedureStep =>
  ({ tool, verb, arg, msgIndex: mi++ });
const read = (f: string) => step("Read", f);
const edit = (f: string) => step("Edit", f);
const test_ = () => step("Bash:pnpm", "pnpm test");
const task = () => step("Task", "explore the codebase");
const session = (steps: ProcedureStep[], sessionId = "s1"): SessionSequence =>
  ({ steps, sessionId, transcript: "t.jsonl", atMs: 1000 });
const signalOf = (...sessions: SessionSequence[]): WorkflowSignal =>
  ({ sequences: { root: "/tmp/p", sessions } } as unknown as WorkflowSignal);

describe("stageLabels", () => {
  it("classifies steps into the four AgentLens intent stages", () => {
    expect(stageOf(read("src/a.ts"))).toBe("exploration");
    expect(stageOf(step("Grep", "foo"))).toBe("exploration");
    expect(stageOf(step("Bash:ls", "ls -la src"))).toBe("exploration");
    expect(stageOf(edit("src/a.ts"))).toBe("implementation");
    expect(stageOf(step("Write", "src/b.ts"))).toBe("implementation");
    expect(stageOf(test_())).toBe("verification");
    expect(stageOf(step("Bash:tsc", "tsc --noEmit"))).toBe("verification");
    expect(stageOf(task())).toBe("orchestration");
    expect(stageOf(step("Bash:curl", "curl example.com"))).toBe("other");
  });

  it("profiles a session's stage mix", () => {
    const p = stageProfile([read("a"), read("b"), edit("a"), test_(), task()]);
    expect(p).toEqual({ exploration: 2, implementation: 1, verification: 1, orchestration: 1, other: 0 });
  });
});
