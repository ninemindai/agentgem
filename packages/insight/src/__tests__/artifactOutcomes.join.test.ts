// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { buildArtifactOutcomeRows } from "../artifactOutcomes.js";
import type { WorkflowSignal } from "../workflowScan.js";
import type { SessionFacet } from "../facets.js";

function signalWith(sessions: unknown[]): WorkflowSignal {
  return { sequences: { root: "/repo", sessions } } as unknown as WorkflowSignal;
}
function facet(sessionId: string, outcome: SessionFacet["outcome"],
  origin: SessionFacet["origin"] = "llm"): SessionFacet {
  return { sessionId, transcript: `${sessionId}.jsonl`, atMs: 100, underlying_goal: "g",
    brief_summary: "s", outcome, friction_detail: "", model: "claude-opus", origin };
}

describe("buildArtifactOutcomeRows", () => {
  it("joins eventSeries to the session's outcome by sessionId", () => {
    const signal = signalWith([{
      sessionId: "S1", transcript: "S1.jsonl", atMs: 100, model: "claude-opus",
      missionHint: { task: "fix the bug", outcome: "" }, steps: [],
      eventSeries: [
        { msgIndex: 1, kind: "skill", name: "superpowers:brainstorming" },
        { msgIndex: 2, kind: "agent", name: "Explore" },
      ],
    }]);
    const rows = buildArtifactOutcomeRows(signal, [facet("S1", "mostly_achieved")],
      { project: "/repo", agent: null });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      sessionId: "S1", artifactType: "skill", artifactName: "superpowers:brainstorming",
      outcome: "mostly_achieved", project: "/repo", agent: null,
      model: "claude-opus", missionHint: "fix the bug", atMs: 100,
    });
    expect(rows[1]).toMatchObject({ artifactType: "agent", artifactName: "Explore" });
  });

  it("skips a session with no facet (never writes a null outcome)", () => {
    const signal = signalWith([{
      sessionId: "S2", transcript: "S2.jsonl", atMs: 100, missionHint: { task: "t", outcome: "" },
      steps: [], eventSeries: [{ msgIndex: 1, kind: "skill", name: "a" }],
    }]);
    expect(buildArtifactOutcomeRows(signal, [], { project: "/repo", agent: null })).toEqual([]);
  });

  it("G1: skips heuristic-origin facets (judge-degraded placeholders)", () => {
    const signal = signalWith([{
      sessionId: "S3", transcript: "S3.jsonl", atMs: 100, missionHint: { task: "t", outcome: "" },
      steps: [], eventSeries: [{ msgIndex: 1, kind: "skill", name: "a" }],
    }]);
    // deterministicFacets emits origin:"heuristic" with a placeholder outcome —
    // must not be persisted as a real judgment.
    const rows = buildArtifactOutcomeRows(signal,
      [facet("S3", "partially_achieved", "heuristic")], { project: "/repo", agent: null });
    expect(rows).toEqual([]);
  });

  it("emits one row per artifact per session (dedupes repeated firings)", () => {
    const signal = signalWith([{
      sessionId: "S4", transcript: "S4.jsonl", atMs: 100, missionHint: { task: "t", outcome: "" },
      steps: [], eventSeries: [
        { msgIndex: 1, kind: "skill", name: "a" },
        { msgIndex: 5, kind: "skill", name: "a" },
      ],
    }]);
    const rows = buildArtifactOutcomeRows(signal, [facet("S4", "partially_achieved")],
      { project: "/repo", agent: null });
    expect(rows).toHaveLength(1);
  });
});
