// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { detectorGuardrails } from "../guardrails.js";

function sig(steps: any[]) {
  return { root: "/r", flavor: "claude", sequences: { sessions: [{ steps, sessionId: "s1", transcript: "s1.jsonl", atMs: 5 }] } } as any;
}
const step = (tool: string, over: object = {}) => ({ tool, verb: tool.toLowerCase(), arg: "", msgIndex: 0, ...over });

describe("detectorGuardrails", () => {
  it("maps a repeated-tool-error finding to a draft with coordinates-only provenance", () => {
    const drafts = detectorGuardrails(sig([step("Bash", { error: true, msgIndex: 1 }), step("Bash", { error: true, msgIndex: 2 })]));
    expect(drafts).toHaveLength(1);
    expect(drafts[0].detectorId).toBe("repeated-tool-error");
    expect(drafts[0].occurrences).toBe(2);
    expect(drafts[0].provenance.occurrences[0].sessionId).toBe("s1");
    expect(drafts[0].detail).not.toContain("/r");   // no raw path leakage
  });
  it("returns [] when nothing fires", () => {
    expect(detectorGuardrails(sig([step("Bash")]))).toEqual([]);
  });
});
