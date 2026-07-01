// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { timeAgo } from "./timeAgo.js";

describe("timeAgo", () => {
  const now = 1_000_000_000_000;
  it("formats recent, minutes, and hours", () => {
    expect(timeAgo(now - 5_000, now)).toBe("just now");
    expect(timeAgo(now - 3 * 60_000, now)).toBe("3m ago");
    expect(timeAgo(now - 2 * 3_600_000, now)).toBe("2h ago");
  });
  it("formats days", () => {
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});
