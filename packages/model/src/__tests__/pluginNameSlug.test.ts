// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { pluginNameSlug } from "../index.js";

describe("pluginNameSlug", () => {
  it("lowercases and replaces illegal chars with hyphens", () => {
    expect(pluginNameSlug("My Gem!")).toBe("my-gem");
    expect(pluginNameSlug("ALL_CAPS_NAME")).toBe("all-caps-name");
  });
  it("collapses runs and trims to alphanumeric edges", () => {
    expect(pluginNameSlug("--weird--name--")).toBe("weird-name");
    expect(pluginNameSlug("reports..plugin")).toBe("reports.plugin");
    expect(pluginNameSlug("trailing-.")).toBe("trailing");
  });
  it("clamps to 64 chars and re-trims the cut edge", () => {
    expect(pluginNameSlug("a".repeat(70))).toBe("a".repeat(64));
    expect(pluginNameSlug("a".repeat(63) + "-bcd")).toBe("a".repeat(63));
  });
  it("falls back to 'gem' when nothing survives", () => {
    expect(pluginNameSlug("日本語")).toBe("gem");
    expect(pluginNameSlug("")).toBe("gem");
  });
  it("keeps already-valid names unchanged", () => {
    expect(pluginNameSlug("reports-plugin")).toBe("reports-plugin");
  });
});
