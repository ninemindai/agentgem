// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import type { RubricReport } from "@agentgem/insight";
import { RubricVerdictBody } from "@agentgem/app/rubric.stream.schema";
import { withoutVerdictNotes } from "@agentgem/app/rubricCore";

describe("RubricVerdictBody", () => {
  it("accepts a well-formed verdict", () => {
    const r = RubricVerdictBody.safeParse({
      sessionId: "s1", factorId: "committed-without-tests",
      rubricId: "ship-discipline", verdict: "wrong", note: "CI runs them",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown verdict value", () => {
    const r = RubricVerdictBody.safeParse({
      sessionId: "s1", factorId: "f1", rubricId: "r1", verdict: "dismissed",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a client-supplied atMs rather than silently ignoring it", () => {
    // Server-assigned only. .strict() turns a stale client into a 422, not a lie
    // about when the call was made.
    const r = RubricVerdictBody.safeParse({
      sessionId: "s1", factorId: "f1", rubricId: "r1", verdict: "accepted", atMs: 5,
    });
    expect(r.success).toBe(false);
  });

  it("rejects an over-long note", () => {
    const r = RubricVerdictBody.safeParse({
      sessionId: "s1", factorId: "f1", rubricId: "r1", verdict: "accepted", note: "x".repeat(501),
    });
    expect(r.success).toBe(false);
  });

  it("rejects blank identifiers", () => {
    expect(RubricVerdictBody.safeParse({ sessionId: "", factorId: "f1", rubricId: "r1", verdict: "accepted" }).success).toBe(false);
    expect(RubricVerdictBody.safeParse({ sessionId: "s1", factorId: "", rubricId: "r1", verdict: "accepted" }).success).toBe(false);
  });
});

describe("withoutVerdictNotes", () => {
  it("strips per-session verdicts AND calibration before the payload reaches an agent", () => {
    const payload: RubricReport = {
      rubricId: "ship-discipline", target: "overview", scope: "session",
      factors: [{ id: "f1", title: "T", advice: "A", severity: "warn" as const, count: 1, sessions: 1,
                  calibration: { reviewed: 2, accepted: 1, wrong: 1, wontfix: 0 } }],
      sessionsScanned: 1, clean: false, degraded: false, skippedFactors: [],
      calibrationUnavailable: false,
      perSession: [{ sessionId: "s1", transcript: "/tmp/s1.jsonl", factors: [],
                     verdicts: { f1: { sessionId: "s1", factorId: "f1", rubricId: "ship-discipline",
                                       verdict: "wrong" as const, note: "SECRET", atMs: 1 } } }],
    };
    const out = withoutVerdictNotes(payload);
    expect(out.perSession![0]).not.toHaveProperty("verdicts");
    expect(JSON.stringify(out)).not.toContain("SECRET");
    // Calibration is integers, but the agent has no guard equivalent to the console's
    // calibrationLine — it must not see it either, or it can render an "accuracy" tile
    // over the wrong denominator (spec §4). Same for the top-level unavailable flag.
    expect(out.factors[0]).not.toHaveProperty("calibration");
    expect(out).not.toHaveProperty("calibrationUnavailable");
  });
});
