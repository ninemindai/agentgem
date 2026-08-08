// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RubricReport } from "@agentgem/insight";
import { withVerdicts, recordRubricVerdict } from "@agentgem/app/rubricCore";

function tmpDb(name = "verdicts.db"): string {
  return join(mkdtempSync(join(tmpdir(), "agentgem-decorate-")), name);
}

const baseReport = (): RubricReport => ({
  rubricId: "ship-discipline",
  target: "overview",
  scope: "session",
  factors: [
    { id: "committed-without-tests", title: "Committed without running the tests", advice: "Run the tests first.", severity: "warn", count: 1, sessions: 1 },
    { id: "no-verify-finish", title: "Finished without verifying", advice: "Verify before finishing.", severity: "info", count: 0, sessions: 0 },
  ],
  sessionsScanned: 1,
  clean: false,
  degraded: false,
  skippedFactors: [],
  perSession: [{ sessionId: "s1", transcript: "/tmp/s1.jsonl", factors: [] }],
});

describe("withVerdicts", () => {
  it("decorates a factor with its all-time calibration", () => {
    const db = tmpDb();
    recordRubricVerdict({ sessionId: "s1", factorId: "committed-without-tests", rubricId: "ship-discipline", verdict: "wrong" }, db);
    recordRubricVerdict({ sessionId: "s2", factorId: "committed-without-tests", rubricId: "ship-discipline", verdict: "accepted" }, db);
    const out = withVerdicts(baseReport(), db);
    expect(out.factors[0].calibration).toEqual({ reviewed: 2, accepted: 1, wrong: 1, wontfix: 0 });
  });

  it("leaves a factor with no verdicts undecorated rather than zeroed", () => {
    const out = withVerdicts(baseReport(), tmpDb());
    expect(out.factors[0].calibration).toBeUndefined();
    expect(out.factors[1].calibration).toBeUndefined();
  });

  it("attaches the current verdict to the matching per-session row", () => {
    const db = tmpDb();
    recordRubricVerdict({ sessionId: "s1", factorId: "committed-without-tests", rubricId: "ship-discipline", verdict: "wontfix", note: "spike branch" }, db);
    const out = withVerdicts(baseReport(), db);
    expect(out.perSession![0].verdicts!["committed-without-tests"].verdict).toBe("wontfix");
    expect(out.perSession![0].verdicts!["committed-without-tests"].note).toBe("spike branch");
  });

  it("degrades to unavailable when the store cannot be read — not to zero, not to silence", () => {
    const path = tmpDb("future.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version','99')").run();
    db.close();
    const out = withVerdicts(baseReport(), path);
    expect(out.factors[0].calibration).toBeUndefined();
    // The flag is the point: without it a broken store looks like an untriaged factor.
    expect(out.calibrationUnavailable).toBe(true);
    expect(out.factors).toHaveLength(2);           // findings intact
    expect(out.perSession![0].verdicts).toBeUndefined();
  });

  it("does not set the unavailable flag on a healthy but empty store", () => {
    expect(withVerdicts(baseReport(), tmpDb()).calibrationUnavailable).toBeUndefined();
  });

  it("assigns atMs server-side rather than trusting the caller", () => {
    const db = tmpDb();
    const r = recordRubricVerdict(
      { sessionId: "s1", factorId: "committed-without-tests", rubricId: "ship-discipline", verdict: "wrong" },
      db, () => 4242,
    );
    expect(r.atMs).toBe(4242);
    expect(withVerdicts(baseReport(), db).perSession![0].verdicts!["committed-without-tests"].atMs).toBe(4242);
  });

  it("never alters the report's own honesty fields", () => {
    const db = tmpDb();
    recordRubricVerdict({ sessionId: "s1", factorId: "committed-without-tests", rubricId: "ship-discipline", verdict: "wrong" }, db);
    const before = baseReport();
    const after = withVerdicts(before, db);
    expect(after.clean).toBe(before.clean);
    expect(after.degraded).toBe(before.degraded);
    expect(after.sessionsScanned).toBe(before.sessionsScanned);
    expect(after.factors.map((f) => f.count)).toEqual(before.factors.map((f) => f.count));
  });
});
