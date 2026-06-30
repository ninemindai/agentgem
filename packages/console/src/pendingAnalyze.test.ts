import { describe, it, expect, beforeEach } from "vitest";
import { setPendingAnalyze, consumePendingAnalyze } from "./pendingAnalyze.js";

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
