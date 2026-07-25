// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The cohort claim must be absent unless it is backed by a real, large-enough sample.
import { describe, expect, it } from "vitest";
import { COHORT, MIN_COHORT, type Cohort, cohortLabel, percentileFor } from "../gemit/cohort.js";

const table = (): Cohort => ({
  asOf: "2026-07-25",
  n: 1284,
  // percentile at each composite 0..100; monotonic, coarse on purpose
  p: Array.from({ length: 101 }, (_, i) => Math.min(99, Math.round(i * 0.99))),
});

describe("percentileFor", () => {
  it("returns null when no cohort has been generated", () => {
    expect(percentileFor(79, null)).toBeNull();
    expect(percentileFor(79, undefined)).toBeNull();
  });

  it("returns null when the sample is too small to claim anything", () => {
    expect(percentileFor(79, { ...table(), n: MIN_COHORT - 1 })).toBeNull();
  });

  it("reads the percentile for a composite from a real table", () => {
    expect(percentileFor(79, table())).toBe(78);
    expect(percentileFor(0, table())).toBe(0);
    expect(percentileFor(100, table())).toBe(99);
  });

  it("clamps out-of-range composites instead of returning undefined", () => {
    expect(percentileFor(-5, table())).toBe(0);
    expect(percentileFor(150, table())).toBe(99);
  });

  it("returns null for a malformed table rather than a wrong number", () => {
    expect(percentileFor(79, { asOf: "2026-07-25", n: 1284, p: [] })).toBeNull();
  });

  it("ships with the claim switched off", () => {
    expect(COHORT).toBeNull();
  });
});

describe("cohortLabel", () => {
  it("discloses sample size and date so staleness is a stated fact", () => {
    expect(cohortLabel(table())).toBe("of 1,284 shared cards, Jul 2026");
  });
});
