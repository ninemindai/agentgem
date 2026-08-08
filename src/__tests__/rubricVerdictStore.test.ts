// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRubricVerdictStore, foldCalibration, NOTE_MAX, type RubricVerdict } from "@agentgem/insight";

const row = (o: Partial<RubricVerdict> & { sessionId: string; factorId: string; verdict: RubricVerdict["verdict"] }): RubricVerdict =>
  ({ atMs: 1000, rubricId: "ship-discipline", ...o });

function tmpDb(name = "verdicts.db"): string {
  return join(mkdtempSync(join(tmpdir(), "agentgem-verdicts-")), name);
}

describe("rubricVerdictStore", () => {
  it("round-trips a verdict", () => {
    const s = openRubricVerdictStore(tmpDb());
    s.recordVerdict(row({ sessionId: "s1", factorId: "f1", verdict: "wrong", note: "monorepo runs tests in CI" }));
    const rows = s.verdictRowsForFactors("ship-discipline", ["f1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe("wrong");
    expect(rows[0].note).toBe("monorepo runs tests in CI");
    s.close();
  });

  it("returns rows in (at_ms, id) order so a same-millisecond rewrite wins", () => {
    const s = openRubricVerdictStore(tmpDb());
    s.recordVerdict(row({ sessionId: "s1", factorId: "f1", verdict: "wrong", atMs: 500 }));
    s.recordVerdict(row({ sessionId: "s1", factorId: "f1", verdict: "accepted", atMs: 500 }));
    expect(s.verdictRowsForFactors("ship-discipline", ["f1"]).map((r) => r.verdict)).toEqual(["wrong", "accepted"]);
    s.close();
  });

  it("does NOT return another rubric's verdict on the same factor id", () => {
    // Inline criteria are rubric-local, so `no-verify-finish` in `hygiene` may be a
    // different question from `no-verify-finish` in `ship-discipline` (spec §1.4).
    const s = openRubricVerdictStore(tmpDb());
    s.recordVerdict(row({ sessionId: "s1", factorId: "no-verify-finish", verdict: "wrong", rubricId: "hygiene" }));
    expect(s.verdictRowsForFactors("hygiene", ["no-verify-finish"])).toHaveLength(1);
    expect(s.verdictRowsForFactors("ship-discipline", ["no-verify-finish"])).toEqual([]);
    s.close();
  });

  it("filters by the requested factors and sessions", () => {
    const s = openRubricVerdictStore(tmpDb());
    s.recordVerdict(row({ sessionId: "s1", factorId: "f1", verdict: "wrong" }));
    s.recordVerdict(row({ sessionId: "s2", factorId: "f2", verdict: "accepted" }));
    expect(s.verdictRowsForFactors("ship-discipline", ["f1"]).map((r) => r.factorId)).toEqual(["f1"]);
    expect(s.verdictRowsForSessions("ship-discipline", ["s2"]).map((r) => r.sessionId)).toEqual(["s2"]);
    expect(s.verdictRowsForFactors("ship-discipline", [])).toEqual([]);
    s.close();
  });

  it("refuses a note longer than NOTE_MAX at the store boundary", () => {
    // Enforced HERE, not only in the route: a direct caller or a test must not be able
    // to persist an oversized note past a guard the route happens to own.
    const s = openRubricVerdictStore(tmpDb());
    expect(() => s.recordVerdict(row({ sessionId: "s1", factorId: "f1", verdict: "wrong", note: "x".repeat(NOTE_MAX + 1) })))
      .toThrow(/note exceeds/);
    s.close();
  });

  it("reopens an existing file without duplicating rows or columns", () => {
    const path = tmpDb();
    const a = openRubricVerdictStore(path);
    a.recordVerdict(row({ sessionId: "s1", factorId: "f1", verdict: "wrong" }));
    a.close();
    const b = openRubricVerdictStore(path);
    expect(b.verdictRowsForFactors("ship-discipline", ["f1"])).toHaveLength(1);
    b.recordVerdict(row({ sessionId: "s1", factorId: "f1", verdict: "accepted", atMs: 2000 }));
    expect(foldCalibration(b.verdictRowsForFactors("ship-discipline", ["f1"])).get("f1")).toEqual({ reviewed: 1, accepted: 1, wrong: 0, wontfix: 0 });
    b.close();
  });

  it("refuses to open an unknown schema version rather than misreading it", () => {
    const path = tmpDb("future.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version','99')").run();
    db.close();
    expect(() => openRubricVerdictStore(path)).toThrow(/schema version '99'/);
  });

  it("refuses a path that cannot be opened", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentgem-verdicts-"));
    writeFileSync(join(dir, "blocker"), "not a directory");
    // A file standing where a directory must be — mkdirSync fails, so the open fails.
    expect(() => openRubricVerdictStore(join(dir, "blocker", "verdicts.db"))).toThrow();
  });
});
