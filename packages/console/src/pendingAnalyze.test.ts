import { describe, it, expect, beforeEach } from "vitest";
import { setPendingAnalyze, consumePendingAnalyze, setPendingPlaybook, consumePendingPlaybook, setPendingContribution, consumePendingContribution } from "./pendingAnalyze.js";

beforeEach(() => { consumePendingAnalyze(); }); // clear any leftover target

describe("pendingAnalyze hand-off", () => {
  it("returns null when nothing is pending", () => {
    expect(consumePendingAnalyze()).toBeNull();
  });

  it("hands a project root from Insights to Curate exactly once", () => {
    setPendingAnalyze("/home/me/proj");
    expect(consumePendingAnalyze()).toBe("/home/me/proj");
    expect(consumePendingAnalyze()).toBeNull(); // consumed — a later navigation won't re-trigger
  });
});

it("hands a playbook draft from Insights to Curate exactly once", () => {
  setPendingPlaybook({ root: "/r", skills: ["a"], lessons: ["b"] });
  expect(consumePendingPlaybook()).toEqual({ root: "/r", skills: ["a"], lessons: ["b"] });
  expect(consumePendingPlaybook()).toBeNull();
});

it("hands a ready selection (setup / lesson share) to Curate exactly once", () => {
  const contrib = { keys: ["skills::x", "instructions::y"], skillCount: 1, lessonCount: 1, name: "my-setup" };
  setPendingContribution(contrib);
  expect(consumePendingContribution()).toEqual(contrib);
  expect(consumePendingContribution()).toBeNull();
});
