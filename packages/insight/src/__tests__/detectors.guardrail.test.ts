// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { runDetectors } from "../detectors.js";

function sig(steps: any[]) {
  return { root: "/r", flavor: "claude", sequences: { sessions: [{ steps, sessionId: "s1", transcript: "s1.jsonl", atMs: 0 }] } } as any;
}
const step = (tool: string, over: object = {}) => ({ tool, verb: tool.toLowerCase(), arg: "", msgIndex: 0, ...over });

describe("guardrail detectors", () => {
  it("repeated-tool-error fires at >=2 same-tool errors", () => {
    const f = runDetectors(sig([step("Bash", { error: true }), step("Bash", { error: true })]));
    expect(f.some((x) => x.detectorId === "repeated-tool-error")).toBe(true);
  });
  it("repeated-tool-error does NOT fire on a single error", () => {
    const f = runDetectors(sig([step("Bash", { error: true })]));
    expect(f.some((x) => x.detectorId === "repeated-tool-error")).toBe(false);
  });
  it("tool-rejection fires at >=2 rejections", () => {
    const f = runDetectors(sig([step("Edit", { rejected: true }), step("Edit", { rejected: true })]));
    expect(f.some((x) => x.detectorId === "tool-rejection")).toBe(true);
  });
});
