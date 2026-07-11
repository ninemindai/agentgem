// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { guardrailEntries } from "../harvest.js";

const draft = { detectorId: "repeated-tool-error", tool: "Bash", detail: "Bash errored 2x", confidence: "medium" as const, occurrences: 2,
  provenance: { occurrences: [{ sessionId: "s1", transcript: "s1.jsonl", messageIndices: [1, 2], atMs: 0 }] } };

describe("guardrailEntries", () => {
  it("keys on provenanceHash and marks kind guardrail", () => {
    const [e] = guardrailEntries("/root", [draft], 100);
    expect(e.kind).toBe("guardrail");
    expect(e.key.startsWith("guardrail:/root:repeated-tool-error:")).toBe(true);
    expect(e.status).toBe("queued");
  });
  it("same draft twice → identical key (dedupe-stable)", () => {
    const a = guardrailEntries("/root", [draft], 1)[0].key;
    const b = guardrailEntries("/root", [draft], 2)[0].key;
    expect(a).toBe(b);
  });
});
