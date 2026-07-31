// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The verdict line is the rubric's headline claim. It must never read as an
// all-clear over sessions the LLM criteria never looked at — the same rule
// judgeCoverage enforces for the insights report.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RubricReportCard } from "../index.js";
import type { RubricReportView } from "../rubricStream.js";

afterEach(cleanup);

const base: RubricReportView = {
  rubricId: "rigor", target: "overview", scope: "project",
  factors: [
    { id: "retry-storm", title: "Retry storm", advice: "a", severity: "warn", count: 0, sessions: 0 },
    { id: "verified", title: "Verified", advice: "b", severity: "warn", count: 0, sessions: 0 },
  ],
  sessionsScanned: 1900,
  clean: true,
  degraded: false,
  skippedFactors: [],
};

describe("rubric verdict — scope honesty", () => {
  it("claims a full all-clear only when coverage was complete", () => {
    render(<RubricReportCard report={{ ...base, judgeCoverage: { eligible: 1900, judged: 1900, sampled: false, truncated: 0 } }} />);
    expect(screen.getByText(/clean — all 2 checks passed/)).toBeTruthy();
  });

  it("does not claim all-clear when criteria only saw a sample", () => {
    render(<RubricReportCard report={{ ...base, clean: false, judgeCoverage: { eligible: 214, judged: 30, sampled: true, truncated: 0 } }} />);
    expect(screen.queryByText(/all 2 checks passed/)).toBeNull();
    // and must NOT read as "0 of 2 checks need action" — nothing was found
    expect(screen.queryByText(/0 of 2 checks need action/)).toBeNull();
    expect(screen.getByText(/no findings in the 30 of 214 sessions checked/)).toBeTruthy();
  });

  it("still reports actionable findings normally when the cap also bit", () => {
    const withFinding = { ...base, clean: false, factors: [{ ...base.factors[0], count: 3 }, base.factors[1]],
      judgeCoverage: { eligible: 214, judged: 30, sampled: true, truncated: 0 } };
    render(<RubricReportCard report={withFinding} />);
    expect(screen.getByText(/1 of 2 checks need action/)).toBeTruthy();
  });

  it("does not read as '0 need action' when the agent degraded either", () => {
    render(<RubricReportCard report={{ ...base, clean: false, degraded: true }} />);
    expect(screen.queryByText(/0 of 2 checks need action/)).toBeNull();
  });
});
