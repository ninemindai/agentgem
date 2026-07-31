// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Rubrics/__tests__/factorRow.test.tsx
//
// The user-visible payload of the applicability change: a check that never applied
// must not read as a check that passed. "no findings" on an unexercised criterion is
// the exact false all-clear the denominator exists to prevent.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { RubricReportCard } from "../index.js";
import type { RubricReportView, RubricFactorView } from "../rubricStream.js";

afterEach(cleanup);

function reportWith(factors: RubricFactorView[]): RubricReportView {
  return {
    rubricId: "rigor", target: "overview", scope: "project", factors,
    sessionsScanned: 30, clean: false, degraded: false, skippedFactors: [],
  };
}
const base = { title: "Verified the real case?", advice: "verify the real thing", severity: "warn" as const };

describe("FactorRow applicability", () => {
  it("says a criterion did not apply rather than reporting no findings", () => {
    render(<RubricReportCard report={reportWith([
      { id: "c1", ...base, count: 0, sessions: 0, applicableSessions: 0, judgedSessions: 30 },
    ])} />);
    // Scope to the row — the card's own summary chrome also contains this wording.
    const row = within(screen.getByRole("listitem"));
    expect(row.queryByText(/no findings/i)).toBeNull();
    expect(row.getByText(/did not apply/i)).toBeTruthy();
  });

  it("reports fires against the applicable denominator, not the raw session count", () => {
    render(<RubricReportCard report={reportWith([
      { id: "c1", ...base, count: 2, sessions: 2, applicableSessions: 9, judgedSessions: 30 },
    ])} />);
    expect(screen.getByText(/2 in 2 of 9 applicable/i)).toBeTruthy();
  });

  it("shows a passing criterion against its denominator", () => {
    render(<RubricReportCard report={reportWith([
      { id: "c1", ...base, count: 0, sessions: 0, applicableSessions: 9, judgedSessions: 30 },
    ])} />);
    expect(screen.getByText(/no findings in 9 applicable/i)).toBeTruthy();
  });

  // A fire can come from a session outside the denominator (a clipped one). Saying
  // "did not apply" while showing that finding's advice reads as a contradiction.
  it("leads with the finding when a fire has no usable denominator", () => {
    render(<RubricReportCard report={reportWith([
      { id: "c1", ...base, count: 1, sessions: 1, applicableSessions: 0, judgedSessions: 4 },
    ])} />);
    const row = within(screen.getByRole("listitem"));
    expect(row.queryByText(/did not apply/i)).toBeNull();
    expect(row.getByText(/1 in 1 session/i)).toBeTruthy();
  });

  // Cheap detectors and aggregate criteria carry no denominator — they must render
  // exactly as they did before this change.
  it("renders a row without applicability data exactly as before", () => {
    render(<RubricReportCard report={reportWith([
      { id: "retry-storm", ...base, count: 3, sessions: 2 },
      { id: "thrash-loop", ...base, count: 0, sessions: 0 },
    ])} />);
    expect(screen.getByText("3 in 2 sessions")).toBeTruthy();
    expect(screen.getByText("no findings")).toBeTruthy();
  });
});
