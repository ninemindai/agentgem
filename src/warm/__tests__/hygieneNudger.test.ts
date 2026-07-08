// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/__tests__/hygieneNudger.test.ts
import { describe, it, expect } from "vitest";
import { createHygieneNudger } from "../hygieneNudger.js";
import type { HygieneReport } from "../../sessionHygieneCore.js";

// Minimal report with a chosen verdict + a fired factor (so buildTickEvents has advice).
function report(sessionId: string, verdict: "bounded" | "mixed" | "bloated"): HygieneReport {
  return {
    meta: { sessionId, transcript: `${sessionId}.jsonl`, model: "m", cap: 1_000_000 },
    curve: [{ turn: 0, msgIndex: 0, ctxTokens: 900_000, cacheCreation: 0, outTokens: 1 }],
    events: [],
    factors: [{ id: "context-pinned", title: "Window pinned", advice: "Take a clean break.", severity: "warn", count: verdict === "bounded" ? 0 : 1, sessions: 1 }],
    hygiene: { score: verdict === "bounded" ? 90 : 20, verdict },
  } as HygieneReport;
}

describe("createHygieneNudger", () => {
  // reportForFile returns the CURRENT report for the session, mutated between
  // nudge() calls, so the nudger's internal `last` map sees a real verdict climb.
  function run(steps: ("bounded" | "mixed" | "bloated")[], sessionId = "s1", file = "/x/s1.jsonl") {
    const notes: { title: string; body: string }[] = [];
    let current = report(sessionId, steps[0]);
    const nudger = createHygieneNudger({ notify: (title, body) => notes.push({ title, body }), reportForFile: () => current });
    for (const v of steps) { current = report(sessionId, v); nudger.nudge([file]); }
    return notes;
  }

  it("fires exactly once on a bounded→mixed climb, carrying the advice", () => {
    const notes = run(["bounded", "mixed"]);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toMatch(/context is heavy/i);
    expect(notes[0].body).toContain("Take a clean break.");
    expect(notes[0].body).toContain("s1.jsonl");   // basename, not a path
    expect(notes[0].body).not.toContain("/x/");
  });
  it("stays silent while a session holds at mixed", () => {
    expect(run(["bounded", "mixed", "mixed", "mixed"])).toHaveLength(1);   // only the initial climb
  });
  it("re-arms: bloated→bounded→bloated fires twice", () => {
    expect(run(["bounded", "bloated", "bounded", "bloated"])).toHaveLength(2);
  });
  it("skips a file whose report throws, without throwing, and processes the rest", () => {
    const notes: { title: string; body: string }[] = [];
    const good = report("g", "bloated");
    const nudger = createHygieneNudger({
      notify: (t, b) => notes.push({ title: t, body: b }),
      reportForFile: (p) => { if (p.includes("bad")) throw new Error("half-written"); return good; },
    });
    expect(() => nudger.nudge(["/x/bad.jsonl", "/x/g.jsonl"])).not.toThrow();
    expect(notes).toHaveLength(1);                  // the good one still fired
  });
});
