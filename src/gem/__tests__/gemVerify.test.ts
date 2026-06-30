// src/gem/__tests__/gemVerify.test.ts
import { describe, it, expect } from "vitest";
import { verifyGemRun, type GemExpectations } from "@agentgem/run";
import type { GemRunOutcome } from "@agentgem/run";

function outcome(over: Partial<GemRunOutcome> & { toolCalls?: GemRunOutcome["result"]["toolCalls"]; text?: string } = {}): GemRunOutcome {
  return {
    ok: over.ok ?? true,
    error: over.error,
    result: {
      text: over.text ?? "",
      toolCalls: over.toolCalls ?? [],
    },
    sandbox: over.sandbox ?? { backend: "child-spawn", isolated: false },
  };
}

const wroteFile: GemRunOutcome = outcome({
  text: "Created the report.",
  toolCalls: [{ toolCallId: "t1", title: "Write(report.md)", kind: "edit", status: "completed" }],
});

describe("verifyGemRun", () => {
  it("passes when the expected tool was invoked, completed, and text matches", () => {
    const exp: GemExpectations = { expectTools: ["Write"], expectText: /report/i };
    const report = verifyGemRun(wroteFile, exp);
    expect(report.passed).toBe(true);
    expect(report.checks.every((c) => c.passed)).toBe(true);
  });

  it("fails when an expected tool was never invoked", () => {
    const report = verifyGemRun(wroteFile, { expectTools: ["Bash"] });
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.name.includes("Bash"))?.passed).toBe(false);
  });

  it("fails when any tool ended in a failed status (default forbids failures)", () => {
    const failed = outcome({ toolCalls: [{ toolCallId: "t1", title: "Write(x)", status: "failed" }] });
    const report = verifyGemRun(failed, { expectTools: ["Write"] });
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.name.toLowerCase().includes("fail"))?.passed).toBe(false);
  });

  it("fails immediately when the run itself errored", () => {
    const errored = outcome({ ok: false, error: "agent run timed out after 300000ms" });
    const report = verifyGemRun(errored, { expectTools: ["Write"] });
    expect(report.passed).toBe(false);
    expect(report.checks[0].detail).toMatch(/timed out/);
  });

  it("fails when expected text is absent", () => {
    const report = verifyGemRun(wroteFile, { expectText: "deploy succeeded" });
    expect(report.passed).toBe(false);
  });

  it("matches tool names case-insensitively and as substrings", () => {
    const report = verifyGemRun(wroteFile, { expectTools: ["write"] });
    expect(report.passed).toBe(true);
  });
});
