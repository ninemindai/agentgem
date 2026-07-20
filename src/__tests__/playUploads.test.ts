// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { PlayBlankRequestSchema, PlayImportRequestSchema, PlayUploadsRequestSchema, PlayUploadsResponseSchema } from "@agentgem/app/schemas";

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

describe("play uploads route schemas", () => {
  it("request accepts name + files with roles", () => {
    const r = PlayUploadsRequestSchema.parse({
      name: "my-game",
      files: [{ name: "a.png", bytesBase64: "AA==", type: "image/png", role: "ship" }],
    });
    expect(r.files[0].role).toBe("ship");
  });
  it("request rejects a missing name", () => {
    expect(() => PlayUploadsRequestSchema.parse({ files: [] })).toThrow();
  });
  it("response carries stored records", () => {
    const r = PlayUploadsResponseSchema.parse({
      files: [{ requested: "My Logo.png", stored: "my-logo.png", role: "ship" }], ship: 1, ref: 0,
    });
    expect(r.files[0].stored).toBe("my-logo.png");
  });
});
