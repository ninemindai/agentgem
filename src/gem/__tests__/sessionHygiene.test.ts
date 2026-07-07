// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/sessionHygiene.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { HYGIENE_FACTOR_IDS, summariesForSpecs, DETECTORS, scanWorkflow } from "@agentgem/insight";
import { buildHygieneReport, sessionHygiene, HygieneInputError } from "../../sessionHygieneCore.js";

describe("HYGIENE_FACTOR_IDS", () => {
  it("is exactly the five context-hygiene detector ids", () => {
    expect([...HYGIENE_FACTOR_IDS].sort()).toEqual(
      ["cache-churn-late", "context-pinned", "reread-churn", "task-pingpong", "task-sprawl"]);
  });
});

describe("summariesForSpecs (now exported)", () => {
  it("returns one row per spec with count 0 when unfired", () => {
    const specs = DETECTORS.filter((d) => HYGIENE_FACTOR_IDS.has(d.id));
    const rows = summariesForSpecs(specs, []);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.count === 0)).toBe(true);
    expect(rows.map((r) => r.id).sort()).toEqual([...HYGIENE_FACTOR_IDS].sort());
  });
});

const emptyInv = { project: { root: "/r", skills: [], mcpServers: [], hooks: [], instructions: [] }, global: { skills: [], mcpServers: [], hooks: [] } } as any;

function writeTranscript(dir: string, usages: Array<{ input: number; cacheRead: number; cacheCreate: number }>): string {
  const lines: string[] = [JSON.stringify({ sessionId: "sessH", type: "user", message: { role: "user", content: "do it" } })];
  usages.forEach((u, i) => lines.push(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant", model: "claude-opus-4-8[1m]",
      content: [{ type: "tool_use", name: "Read", input: { file_path: `packages/p${i}/f.ts` } }],
      usage: { input_tokens: u.input, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheCreate, output_tokens: 10 },
    },
  })));
  const p = join(dir, "sessH.jsonl");
  writeFileSync(p, lines.join("\n"));
  return p;
}

describe("buildHygieneReport", () => {
  it("derives curve, factors, and verdict from a scanned signal", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyg-"));
    const path = writeTranscript(dir, [
      { input: 100, cacheRead: 400_000, cacheCreate: 2000 },
      { input: 100, cacheRead: 500_000, cacheCreate: 3000 },
    ]);
    const signal = scanWorkflow([path], emptyInv, { retainSequences: true });
    const rep = buildHygieneReport(signal);
    expect(rep.meta.model).toBe("claude-opus-4-8[1m]");
    expect(rep.meta.cap).toBe(1_000_000);
    expect(rep.curve).toHaveLength(2);
    expect(rep.curve[0].ctxTokens).toBe(402_100);      // 100 + 400000 + 2000
    expect(rep.factors).toHaveLength(5);               // one row per hygiene factor
    expect(rep.hygiene.verdict).toBe("bounded");       // short, un-pinned session
  });

  it("returns an empty curve and bounded verdict when the signal has no session", () => {
    const rep = buildHygieneReport({ root: "/r", flavor: "claude", sessions: { scanned: 0, firstMs: 0, lastMs: 0, spanDays: 0 }, models: [], artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [] } as any);
    expect(rep.curve).toEqual([]);
    expect(rep.factors).toHaveLength(5);
    expect(rep.hygiene.verdict).toBe("bounded");
  });

  it("includes skill/subagent events on the report", () => {
    const signal = { sequences: { root: "", sessions: [{
      sessionId: "s1", transcript: "s1.jsonl", atMs: 0, steps: [], contextSeries: [],
      eventSeries: [{ msgIndex: 3, kind: "skill", name: "review" }],
    }] } } as any;
    const rep = buildHygieneReport(signal);
    expect(rep.events).toEqual([{ msgIndex: 3, kind: "skill", name: "review" }]);
  });
});

import { HygieneReportSchema } from "../../gem.controller.js";

describe("sessionHygiene guards", () => {
  it("throws HygieneInputError (not a bare Error) for a non-claude agent", async () => {
    await expect(sessionHygiene("whatever", "codex")).rejects.toBeInstanceOf(HygieneInputError);
  });
});

describe("HygieneReportSchema", () => {
  it("accepts a buildHygieneReport output unchanged (server schema matches core shape)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyg2-"));
    const path = writeTranscript(dir, [{ input: 100, cacheRead: 400_000, cacheCreate: 2000 }]);
    const rep = buildHygieneReport(scanWorkflow([path], emptyInv, { retainSequences: true }));
    const parsed = HygieneReportSchema.parse(rep);
    expect(parsed).toEqual(rep);
  });
});
