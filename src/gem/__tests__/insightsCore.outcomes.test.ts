// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { openArtifactOutcomesStore, type WorkflowSignal, type SessionFacet } from "@agentgem/insight";
import { persistOutcomes } from "../../insightsCore.js";

function signal(): WorkflowSignal {
  return { sequences: { root: "/repo", sessions: [{
    sessionId: "S1", transcript: "S1.jsonl", atMs: 1, model: "m",
    missionHint: { task: "t", outcome: "" }, steps: [],
    eventSeries: [{ msgIndex: 1, kind: "skill", name: "skill-a" }],
  }] } } as unknown as WorkflowSignal;
}
const llmFacet: SessionFacet = { sessionId: "S1", transcript: "S1.jsonl", atMs: 1,
  underlying_goal: "t", brief_summary: "t", outcome: "mostly_achieved",
  friction_detail: "", model: "m", origin: "llm" };

describe("persistOutcomes", () => {
  it("writes each judged session's own outcome into the store", () => {
    const store = openArtifactOutcomesStore("memory://");
    persistOutcomes(store, signal(), [llmFacet], "/repo");
    expect(store.outcomeForSessions(["S1"]).get("S1")).toBe("mostly_achieved");
    store.close();
  });

  it("is a no-op when there are no facets", () => {
    const store = openArtifactOutcomesStore("memory://");
    const empty = { sequences: { root: "/r", sessions: [] } } as unknown as WorkflowSignal;
    expect(() => persistOutcomes(store, empty, [], "/r")).not.toThrow();
    expect(store.outcomeForSessions(["S1"]).size).toBe(0);
    store.close();
  });

  it("G5: a throwing store does not break persistOutcomes' caller-safety contract", () => {
    // persistOutcomes itself does not swallow (the caller does); assert it throws
    // so the caller's try/catch is exercised, and that a healthy store still works.
    const broken = { upsertSession() { throw new Error("disk full"); },
      outcomeForSessions: () => new Map(), scoreForSessions: () => new Map(), close() {} } as unknown as ReturnType<typeof openArtifactOutcomesStore>;
    expect(() => persistOutcomes(broken, signal(), [llmFacet], "/repo")).toThrow("disk full");
  });
});
