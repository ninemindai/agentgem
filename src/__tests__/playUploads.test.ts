// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { PlayBlankRequestSchema, PlayImportRequestSchema } from "../schemas.js";

describe("play request schemas accept optional files", () => {
  it("blank accepts files with role", () => {
    const r = PlayBlankRequestSchema.parse({
      title: "x",
      files: [{ name: "a.png", bytesBase64: "AA==", type: "image/png", role: "ship" }],
    });
    expect(r.files?.[0].role).toBe("ship");
  });
  it("blank still parses without files (backward compatible)", () => {
    expect(PlayBlankRequestSchema.parse({ title: "x" }).files).toBeUndefined();
  });
  it("rejects a bad role", () => {
    expect(() => PlayImportRequestSchema.parse({
      title: "x", html: "<html></html>",
      files: [{ name: "a", bytesBase64: "AA==", role: "nope" }],
    })).toThrow();
  });
});
