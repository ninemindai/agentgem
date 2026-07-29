// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// NOTE on test placement: exercises packages/insight/src/artifactOutcomesStore.ts but lives
// here, imported via "@agentgem/insight" — same reason as skillsLayout.test.ts. Root
// vitest.config globs "dist/**/__tests__/**" plus packages/app and packages/fabric only, so a
// test compiled to packages/insight/dist/__tests__ NEVER RUNS. Verified empirically: 20 files
// sit in that dead location today (see the follow-up to widen the glob).
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArtifactOutcomesStore, addColumnIfMissing } from "@agentgem/insight";
import type { ArtifactOutcomeRow } from "@agentgem/insight";

function row(sessionId: string, name: string, outcome: ArtifactOutcomeRow["outcome"]): ArtifactOutcomeRow {
  return { sessionId, artifactType: "skill", artifactName: name, outcome,
    project: "/r", agent: null, model: "m", missionHint: "t", atMs: 1 };
}

describe("ArtifactOutcomesStore", () => {
  it("upserts a session idempotently (re-write replaces, no double count)", () => {
    const s = openArtifactOutcomesStore("memory://");
    s.upsertSession("S1", [row("S1", "skill-a", "mostly_achieved")]);
    s.upsertSession("S1", [row("S1", "skill-a", "mostly_achieved")]); // same again
    // one artifact, one session → Wilson(1,1) ~= 0.21, not the higher Wilson(2,2)
    const score = s.scoreForSessions(["S1"]).get("S1")!;
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.6);
    s.close();
  });

  it("scoreForSessions scores by MAX of artifacts' cross-session outcome-scores (foundation)", () => {
    const s = openArtifactOutcomesStore("memory://");
    for (let i = 0; i < 20; i++) s.upsertSession(`G${i}`, [row(`G${i}`, "skill-good", "mostly_achieved")]);
    for (let i = 0; i < 20; i++) s.upsertSession(`B${i}`, [row(`B${i}`, "skill-bad", "not_achieved")]);
    s.upsertSession("CAND", [row("CAND", "skill-good", "mostly_achieved"), row("CAND", "skill-bad", "not_achieved")]);
    const score = s.scoreForSessions(["CAND"]).get("CAND")!;
    expect(score).toBeGreaterThan(0.6); // dominated by skill-good, not diluted by skill-bad
    s.close();
  });

  it("scoreForSessions omits an unknown session (caller treats as 0)", () => {
    const s = openArtifactOutcomesStore("memory://");
    expect(s.scoreForSessions(["nope"]).has("nope")).toBe(false);
    s.close();
  });

  it("outcomeForSessions returns each session's own outcome (recall's D7 signal)", () => {
    const s = openArtifactOutcomesStore("memory://");
    s.upsertSession("S1", [row("S1", "a", "mostly_achieved"), row("S1", "b", "mostly_achieved")]);
    s.upsertSession("S2", [row("S2", "a", "not_achieved")]);
    const got = s.outcomeForSessions(["S1", "S2"]);
    expect(got.get("S1")).toBe("mostly_achieved"); // one row per session despite 2 artifacts
    expect(got.get("S2")).toBe("not_achieved");
    s.close();
  });

  it("G4: outcomeForSessions on a cold/empty store returns an empty map", () => {
    const s = openArtifactOutcomesStore("memory://");
    expect(s.outcomeForSessions(["anything"]).size).toBe(0);
    s.close();
  });

  it("G2: two handles on one file (WAL) — write on A, read on B, no throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-"));
    try {
      const a = openArtifactOutcomesStore(join(dir, "ao.db"));
      const b = openArtifactOutcomesStore(join(dir, "ao.db"));
      expect(() => {
        a.upsertSession("S1", [row("S1", "a", "mostly_achieved")]);
        // reader on a second handle sees the committed write, no SQLITE_BUSY
        const got = b.outcomeForSessions(["S1"]);
        expect(got.get("S1")).toBe("mostly_achieved");
      }).not.toThrow();
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// These rows are expensive, non-deterministic LLM judgments, so unlike transcriptIndex and
// recallIndex this store must NOT drop-and-rebuild on a schema bump. It also has no migration
// code — it used to just stamp the new version and continue, which is the aggregator's
// column-drift bug: CREATE TABLE IF NOT EXISTS is table-level, so a table that already exists
// keeps its old columns while the code expects new ones. A bump with no migration must fail
// LOUDLY at the first open, not silently produce wrong reads later.
describe("ArtifactOutcomesStore — schema version guard", () => {
  function withTmpDb(fn: (file: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "aos-"));
    try { fn(join(dir, "outcomes.db")); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it("reopens a same-version store without complaint", () => {
    withTmpDb((file) => {
      const a = openArtifactOutcomesStore(file);
      a.upsertSession("S1", [row("S1", "skill-a", "mostly_achieved")]);
      a.close();
      const b = openArtifactOutcomesStore(file);   // same version — must just work
      expect(b.outcomeForSessions(["S1"]).get("S1")).toBe("mostly_achieved");
      b.close();
    });
  });

  it("refuses to open a store written by an UNKNOWN newer schema, naming the versions", () => {
    withTmpDb((file) => {
      const a = openArtifactOutcomesStore(file);
      a.upsertSession("S1", [row("S1", "skill-a", "mostly_achieved")]);
      a.close();
      // Simulate a future build having written this file.
      const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
      const raw = new DatabaseSync(file);
      raw.prepare("UPDATE meta SET value='99' WHERE key='schema_version'").run();
      raw.close();

      expect(() => openArtifactOutcomesStore(file)).toThrow(/schema/i);
      expect(() => openArtifactOutcomesStore(file)).toThrow(/99/);
    });
  });

  it("leaves the rows intact when it refuses — never drops what it cannot migrate", () => {
    withTmpDb((file) => {
      const a = openArtifactOutcomesStore(file);
      a.upsertSession("S1", [row("S1", "skill-a", "mostly_achieved")]);
      a.close();
      const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
      let raw = new DatabaseSync(file);
      raw.prepare("UPDATE meta SET value='99' WHERE key='schema_version'").run();
      raw.close();

      expect(() => openArtifactOutcomesStore(file)).toThrow();

      raw = new DatabaseSync(file);
      const n = (raw.prepare("SELECT count(*) AS c FROM artifact_outcomes").get() as { c: number }).c;
      raw.close();
      expect(n).toBe(1);   // the refusal is non-destructive
    });
  });

  it("addColumnIfMissing is idempotent and preserves existing rows", () => {
    withTmpDb((file) => {
      const a = openArtifactOutcomesStore(file);
      a.upsertSession("S1", [row("S1", "skill-a", "mostly_achieved")]);
      a.close();
      const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
      const raw = new DatabaseSync(file);
      expect(addColumnIfMissing(raw, "artifact_outcomes", "trust_score", "REAL")).toBe(true);   // added
      expect(addColumnIfMissing(raw, "artifact_outcomes", "trust_score", "REAL")).toBe(false);  // already there
      const r = raw.prepare("SELECT session_id, trust_score FROM artifact_outcomes").get() as { session_id: string; trust_score: number | null };
      expect(r.session_id).toBe("S1");
      expect(r.trust_score).toBeNull();
      raw.close();
    });
  });
});
