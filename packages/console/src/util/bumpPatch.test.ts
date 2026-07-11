// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { bumpPatch } from "./bumpPatch.js";

describe("bumpPatch", () => {
  it("increments the patch component", () => {
    expect(bumpPatch("0.1.0")).toBe("0.1.1");
    expect(bumpPatch("1.2.3")).toBe("1.2.4");
  });
  it("carries multi-digit patches", () => {
    expect(bumpPatch("0.1.9")).toBe("0.1.10");
    expect(bumpPatch("2.0.99")).toBe("2.0.100");
  });
  it("pads short versions before bumping", () => {
    expect(bumpPatch("1")).toBe("1.0.1");
    expect(bumpPatch("1.2")).toBe("1.2.1");
  });
});
