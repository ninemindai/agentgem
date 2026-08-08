// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { foldCalibration, latestPerKey, verdictsBySession, verdictKey, type RubricVerdict } from "@agentgem/insight";

const v = (o: Partial<RubricVerdict> & { sessionId: string; factorId: string; verdict: RubricVerdict["verdict"]; atMs: number }): RubricVerdict =>
  ({ rubricId: "ship-discipline", ...o });

describe("rubricVerdicts", () => {
  it("keeps only the latest verdict per (rubric, session, factor) key", () => {
    const rows = [
      v({ sessionId: "s1", factorId: "f1", verdict: "wrong", atMs: 100 }),
      v({ sessionId: "s1", factorId: "f1", verdict: "accepted", atMs: 200 }),
    ];
    const latest = latestPerKey(rows);
    expect(latest.size).toBe(1);
    expect(latest.get(verdictKey("ship-discipline", "s1", "f1"))?.verdict).toBe("accepted");
  });

  it("keeps two rubrics' verdicts on the same factor id apart", () => {
    // Inline criteria are rubric-local: two user rubrics may each define `f1` with a
    // different question, so merging their verdicts would describe neither. See spec §1.4.
    const rows = [
      v({ rubricId: "hygiene", sessionId: "s1", factorId: "f1", verdict: "wrong", atMs: 100 }),
      v({ rubricId: "ship-discipline", sessionId: "s1", factorId: "f1", verdict: "accepted", atMs: 200 }),
    ];
    expect(latestPerKey(rows).size).toBe(2);
  });

  it("resolves a same-millisecond rewrite in favour of the later row", () => {
    // The store returns rows ordered by (at_ms, id) ascending, so the last row wins.
    const rows = [
      v({ sessionId: "s1", factorId: "f1", verdict: "wrong", atMs: 100 }),
      v({ sessionId: "s1", factorId: "f1", verdict: "wontfix", atMs: 100 }),
    ];
    expect(latestPerKey(rows).get(verdictKey("ship-discipline", "s1", "f1"))?.verdict).toBe("wontfix");
  });

  it("counts wrong and wontfix separately — they are different diagnoses", () => {
    const rows = [
      v({ sessionId: "s1", factorId: "f1", verdict: "wrong", atMs: 1 }),
      v({ sessionId: "s2", factorId: "f1", verdict: "wrong", atMs: 2 }),
      v({ sessionId: "s3", factorId: "f1", verdict: "wontfix", atMs: 3 }),
      v({ sessionId: "s4", factorId: "f1", verdict: "accepted", atMs: 4 }),
    ];
    expect(foldCalibration(rows).get("f1")).toEqual({ reviewed: 4, accepted: 1, wrong: 2, wontfix: 1 });
  });

  it("omits a factor with no verdicts rather than reporting zeroes", () => {
    // A zeroed row would render as "never disputed"; absence renders as no line at all.
    expect(foldCalibration([]).has("f1")).toBe(false);
  });

  it("counts a superseded verdict once, under its final value", () => {
    const rows = [
      v({ sessionId: "s1", factorId: "f1", verdict: "wrong", atMs: 1 }),
      v({ sessionId: "s1", factorId: "f1", verdict: "accepted", atMs: 2 }),
    ];
    expect(foldCalibration(rows).get("f1")).toEqual({ reviewed: 1, accepted: 1, wrong: 0, wontfix: 0 });
  });

  it("groups the latest verdicts by session for per-session decoration", () => {
    const rows = [
      v({ sessionId: "s1", factorId: "f1", verdict: "wrong", atMs: 1 }),
      v({ sessionId: "s1", factorId: "f2", verdict: "accepted", atMs: 2 }),
      v({ sessionId: "s2", factorId: "f1", verdict: "wontfix", atMs: 3 }),
    ];
    const bySession = verdictsBySession(rows);
    expect(Object.keys(bySession.get("s1")!).sort()).toEqual(["f1", "f2"]);
    expect(bySession.get("s2")!.f1.verdict).toBe("wontfix");
  });
});
