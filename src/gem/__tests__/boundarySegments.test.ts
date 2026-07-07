// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/boundarySegments.test.ts
import { describe, it, expect } from "vitest";
import { scanWorkflow, boundarySegments, SMOOTH_W, MIN_EPISODE } from "@agentgem/insight";
import type { ProcedureStep, SessionSequence, TurnUsage } from "@agentgem/insight";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildHygieneReport } from "../../sessionHygieneCore.js";
import { HygieneReportSchema } from "../../gem.controller.js";

// Build a session where turn i has one Read step of `clusters[i]` (a path), and a
// contextSeries with ctxTokens = ctx[i]. msgIndex = i for both step and turn, so
// each step aligns to its own turn.
function sess(clusters: (string | null)[], ctx: number[]): SessionSequence {
  const steps: ProcedureStep[] = [];
  clusters.forEach((c, i) => { if (c) steps.push({ tool: "Read", verb: "Read", arg: c, msgIndex: i }); });
  const contextSeries: TurnUsage[] = clusters.map((_, i) => ({ turn: i, msgIndex: i, ctxTokens: ctx[i], cacheCreation: 0, outTokens: 1 }));
  return { steps, sessionId: "s", transcript: "s.jsonl", atMs: 0, contextSeries };
}
const path = (pkg: string) => `packages/${pkg}/f.ts`;   // clusterOf -> pkg:<pkg>

describe("boundarySegments", () => {
  it("splits a two-area session into two episodes with a cut at the transition", () => {
    const clusters = [...Array(6).fill(path("a")), ...Array(6).fill(path("b"))];
    const ctx = [...Array(6).fill(200_000), ...Array(6).fill(900_000)];   // climb at the b boundary
    const { segments, cutTurn } = boundarySegments(sess(clusters, ctx));
    expect(segments.map((s) => s.label)).toEqual(["pkg:a", "pkg:b"]);
    expect(segments[0]).toMatchObject({ fromTurn: 0, toTurn: 5 });
    expect(segments[1]).toMatchObject({ fromTurn: 6, toTurn: 11 });
    expect(cutTurn).toBe(6);
  });

  it("returns one episode and no cut for a single-area session", () => {
    const { segments, cutTurn } = boundarySegments(sess(Array(8).fill(path("a")), Array(8).fill(300_000)));
    expect(segments).toHaveLength(1);
    expect(segments[0].label).toBe("pkg:a");
    expect(cutTurn).toBeNull();
  });

  it("smooths a single ping-pong blip away (still one episode)", () => {
    const clusters = [path("a"), path("a"), path("a"), path("b"), path("a"), path("a"), path("a"), path("a")]; // one stray b
    const { segments } = boundarySegments(sess(clusters, Array(8).fill(300_000)));
    expect(segments).toHaveLength(1);
    expect(segments[0].label).toBe("pkg:a");
  });

  it("carries the file cluster forward across pathless Bash turns", () => {
    // Read a, then pathless Bash (npm test) turns, then Read a again -> ONE pkg:a episode.
    const steps: ProcedureStep[] = [
      { tool: "Read", verb: "Read", arg: path("a"), msgIndex: 0 },
      { tool: "Bash", verb: "Bash:npm", arg: "npm test", msgIndex: 1 },   // clusterOf("npm test") -> null
      { tool: "Bash", verb: "Bash:npm", arg: "npm test", msgIndex: 2 },
      { tool: "Read", verb: "Read", arg: path("a"), msgIndex: 3 },
    ];
    const contextSeries: TurnUsage[] = [0, 1, 2, 3].map((i) => ({ turn: i, msgIndex: i, ctxTokens: 300_000, cacheCreation: 0, outTokens: 1 }));
    const { segments } = boundarySegments({ steps, sessionId: "s", transcript: "s.jsonl", atMs: 0, contextSeries });
    expect(segments).toHaveLength(1);
    expect(segments[0].label).toBe("pkg:a");
  });

  it("picks the cut at the boundary with the larger context climb when two compete", () => {
    // a(0-4) -> b(5-9) small climb -> c(10-14) big climb. Cut should be turn 10.
    const clusters = [...Array(5).fill(path("a")), ...Array(5).fill(path("b")), ...Array(5).fill(path("c"))];
    const ctx = [...Array(5).fill(200_000), ...Array(5).fill(300_000), ...Array(5).fill(950_000)];
    const { cutTurn } = boundarySegments(sess(clusters, ctx));
    expect(cutTurn).toBe(10);
  });

  it("degrades to empty with no contextSeries, no throw", () => {
    const s: SessionSequence = { steps: [{ tool: "Read", verb: "Read", arg: path("a"), msgIndex: 0 }], sessionId: "s", transcript: "s.jsonl", atMs: 0 };
    expect(boundarySegments(s)).toEqual({ segments: [], cutTurn: null });
  });

  it("exports the tunable constants", () => {
    expect(SMOOTH_W).toBe(2);
    expect(MIN_EPISODE).toBe(3);
  });
});

const emptyInv = { project: { root: "/r", skills: [], mcpServers: [], hooks: [], instructions: [] }, global: { skills: [], mcpServers: [], hooks: [] } } as any;

function writeTwoArea(dir: string): string {
  const lines: string[] = [JSON.stringify({ sessionId: "b", type: "user", message: { role: "user", content: "go" } })];
  const push = (pkg: string, ctx: number) => lines.push(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", model: "claude-opus-4-8[1m]",
      content: [{ type: "tool_use", name: "Read", input: { file_path: `packages/${pkg}/f.ts` } }],
      usage: { input_tokens: 100, cache_read_input_tokens: ctx, cache_creation_input_tokens: 2000, output_tokens: 10 } },
  }));
  for (let i = 0; i < 6; i++) push("a", 200_000);
  for (let i = 0; i < 6; i++) push("b", 950_000);
  const p = join(dir, "b.jsonl"); writeFileSync(p, lines.join("\n")); return p;
}
function writeOneArea(dir: string): string {
  const lines: string[] = [JSON.stringify({ sessionId: "o", type: "user", message: { role: "user", content: "go" } })];
  for (let i = 0; i < 5; i++) lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-4-8[1m]",
    content: [{ type: "tool_use", name: "Read", input: { file_path: "packages/a/f.ts" } }],
    usage: { input_tokens: 100, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 2000, output_tokens: 10 } } }));
  const p = join(dir, "o.jsonl"); writeFileSync(p, lines.join("\n")); return p;
}

describe("buildHygieneReport boundary", () => {
  it("attaches boundary with ≥2 episodes + a cut turn for a two-area session", () => {
    const dir = mkdtempSync(join(tmpdir(), "bnd-"));
    const rep = buildHygieneReport(scanWorkflow([writeTwoArea(dir)], emptyInv, { retainSequences: true }));
    expect(rep.boundary).toBeDefined();
    expect(rep.boundary!.segments.length).toBeGreaterThanOrEqual(2);
    expect(rep.boundary!.cutTurn).not.toBeNull();
    expect(HygieneReportSchema.parse(rep)).toEqual(rep);   // schema mirrors the shape
  });
  it("omits boundary for a single-area session", () => {
    const dir = mkdtempSync(join(tmpdir(), "bnd2-"));
    const rep = buildHygieneReport(scanWorkflow([writeOneArea(dir)], emptyInv, { retainSequences: true }));
    expect(rep.boundary).toBeUndefined();
    expect(HygieneReportSchema.parse(rep)).toEqual(rep);
  });
});
