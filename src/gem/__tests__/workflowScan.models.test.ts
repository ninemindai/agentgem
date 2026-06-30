// src/gem/__tests__/workflowScan.models.test.ts
import { describe, it, expect } from "vitest";
import { collectModels } from "@agentgem/insight";

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
