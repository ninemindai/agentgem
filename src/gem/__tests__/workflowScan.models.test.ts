// src/gem/__tests__/workflowScan.models.test.ts
import { describe, it, expect } from "vitest";
import { collectModels, sessionPrimaryModel, createModelTally } from "@agentgem/insight";

describe("sessionPrimaryModel", () => {
  it("returns the most-frequent real model in one session", () => {
    expect(sessionPrimaryModel([
      { message: { model: "claude-opus-4-8" } },
      { message: { model: "claude-opus-4-8" } },
      { message: { model: "gpt-5.1" } },
    ])).toBe("claude-opus-4-8");
  });

  it("lowercases and skips synthetic markers", () => {
    expect(sessionPrimaryModel([
      { message: { model: "<synthetic>" } },
      { message: { model: "GPT-5.1" } },
    ])).toBe("gpt-5.1");
  });

  it("returns undefined when no real model is present", () => {
    expect(sessionPrimaryModel([{ message: { role: "user" } }])).toBeUndefined();
  });
});

describe("collectModels", () => {
  it("collects distinct lowercased model ids with session counts", () => {
    const sessions = [
      [{ message: { role: "assistant", model: "claude-opus-4-8" } }, { message: { role: "assistant", model: "claude-opus-4-8" } }],
      [{ message: { role: "assistant", model: "Claude-Opus-4-8" } }],
      [{ message: { role: "assistant", model: "gpt-5.1" } }],
    ];
    expect(collectModels(sessions)).toEqual([
      { id: "claude-opus-4-8", sessions: 2 },
      { id: "gpt-5.1", sessions: 1 },
    ]);
  });

  it("ignores records with no model", () => {
    expect(collectModels([[{ message: { role: "user" } }]])).toEqual([]);
  });

  it("filters synthetic/placeholder model markers", () => {
    const sessions = [
      [{ message: { role: "assistant", model: "<synthetic>" } }, { message: { role: "assistant", model: "claude-opus-4-8" } }],
    ];
    expect(collectModels(sessions)).toEqual([{ id: "claude-opus-4-8", sessions: 1 }]);
  });
});

describe("createModelTally (streaming) equals collectModels (batch)", () => {
  const tallyOf = (sessions: any[][]) => {
    const t = createModelTally();
    for (const s of sessions) t.addSession(s);   // folded one at a time, records not retained
    return t.finalize();
  };

  it("matches collectModels across mixed sessions, casing, and synthetic markers", () => {
    const sessions = [
      [{ message: { model: "claude-opus-4-8" } }, { message: { model: "claude-opus-4-8" } }],
      [{ message: { model: "Claude-Opus-4-8" } }, { message: { model: "gpt-5.1" } }],
      [{ message: { model: "<synthetic>" } }],
      [{ message: { role: "user" } }],
      [{ message: { model: "gpt-5.1" } }],
    ];
    expect(tallyOf(sessions)).toEqual(collectModels(sessions));
  });

  it("preserves first-seen order under the sessions-desc / id-asc tie-break", () => {
    const sessions = [
      [{ message: { model: "b-model" } }],
      [{ message: { model: "a-model" } }],
      [{ message: { model: "b-model" } }],   // b now leads by session count
    ];
    expect(tallyOf(sessions)).toEqual(collectModels(sessions));
  });

  it("yields [] for an empty corpus", () => {
    expect(tallyOf([])).toEqual(collectModels([]));
  });
});
