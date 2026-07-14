// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArtifactOutcomesStore } from "../artifactOutcomesStore.js";
import type { ArtifactOutcomeRow } from "../artifactOutcomes.js";

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
