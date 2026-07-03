// src/__tests__/journeyCore.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJourney } from "../journeyCore.js";
import { enqueueNew, setStatus, appendDiary } from "../dream/store.js";
import type { DreamQueueEntry } from "../dream/types.js";
import type { VerificationRecord } from "@agentgem/run";

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), "journey-")); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

const entry = (over: Partial<DreamQueueEntry>): DreamQueueEntry => ({
  key: "skill:/p:s1:h", kind: "skill", root: "/p", name: "s1", summary: "does s1",
  phase: "DEEP", draft: {} as DreamQueueEntry["draft"], status: "queued", firstSeenMs: 100, ...over,
});
const verification = (ts: string, over: Partial<VerificationRecord> = {}): VerificationRecord => ({
  ts, gemName: "g", agent: "claude", contractApplied: true,
  run: { ok: true, toolCalls: 1 },
  verification: { passed: true, checks: [{ name: "no tool failures", passed: true, detail: "ok" }] },
  ...over,
});

describe("buildJourney", () => {
  it("merges queue + diary + ledger newest-first, one event per queue item", () => {
    enqueueNew([entry({})], base);                                   // ts 100 (queued)
    enqueueNew([entry({ key: "lesson:/p:l1", kind: "lesson", name: "l1", phase: "LEARN", firstSeenMs: 300 })], base);
    setStatus("skill:/p:s1:h", "accepted", 500, base);               // reviewed → ts 500
    appendDiary({ atMs: 200, passId: 1, rootsProcessed: ["/p"], phasesLit: ["DEEP"], enqueued: { skills: 1, lessons: 0 }, degraded: false }, base);
    const r = buildJourney({ base, readLedger: () => [verification(new Date(400).toISOString())] });
    expect(r.truncated).toBe(false);
    expect(r.events.map((e) => `${e.kind}@${e.ts}`)).toEqual([
      "skill@500", "verified@400", "lesson@300", "pass@200",
    ]);
    const skill = r.events[0];
    expect(skill).toMatchObject({ status: "accepted", firstSeenMs: 100, key: "skill:/p:s1:h", root: "/p" });
    const learn = r.events[2];
    expect(learn).toMatchObject({ phase: "LEARN", status: "queued" });
    const verified = r.events[1];
    expect(verified).toMatchObject({ title: "g", agent: "claude", passed: true });
  });

  it("filters by kind server-side", () => {
    enqueueNew([entry({})], base);
    const r = buildJourney({ base, kind: "verified", readLedger: () => [verification(new Date(50).toISOString())] });
    expect(r.events.map((e) => e.kind)).toEqual(["verified"]);
  });

  it("applies limit newest-first and reports truncation", () => {
    enqueueNew([entry({}), entry({ key: "skill:/p:s2:h", name: "s2", firstSeenMs: 900 })], base);
    const r = buildJourney({ base, limit: 1, readLedger: () => [] });
    expect(r.events.map((e) => e.title)).toEqual(["s2"]);
    expect(r.truncated).toBe(true);
  });

  it("skips ledger records with unparseable timestamps; empty stores yield empty result", () => {
    const bad = buildJourney({ base, readLedger: () => [verification("not-a-date")] });
    expect(bad.events).toEqual([]);
    expect(bad.truncated).toBe(false);
  });

  it("verified failure events carry the first failed check as detail", () => {
    const rec = verification(new Date(10).toISOString(), {
      verification: { passed: false, checks: [{ name: "c1", passed: true, detail: "ok" }, { name: "c2", passed: false, detail: "missed" }] },
    });
    const r = buildJourney({ base, readLedger: () => [rec] });
    expect(r.events[0]).toMatchObject({ passed: false, detail: "c2: missed" });
  });
});
