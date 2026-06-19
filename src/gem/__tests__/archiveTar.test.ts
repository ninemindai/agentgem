// src/gem/__tests__/archiveTar.test.ts
import { describe, it, expect } from "vitest";
import { gunzipSync } from "node:zlib";
import { packTar, unpackTar } from "../archiveTar.js";

describe("packTar/unpackTar", () => {
  it("round-trips a FileTree exactly", () => {
    const tree = {
      "gem.json": '{\n  "name": "demo"\n}',
      "skills/review/SKILL.md": "# Review\nLook for bugs.\n",
      "mcp/gh.json": '{"transport":"stdio"}',
      "instructions/CLAUDE.md.md": "Be concise.",
    };
    expect(unpackTar(packTar(tree))).toEqual(tree);
  });

  it("emits gzip-wrapped output whose inner tar is 512-block aligned", () => {
    const buf = packTar({ "a.txt": "hi" });
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b); // gzip magic
    expect(gunzipSync(buf).length % 512).toBe(0);
  });

  it("handles an empty file and multi-block content", () => {
    const tree = { empty: "", big: "x".repeat(2000) };
    expect(unpackTar(packTar(tree))).toEqual(tree);
  });
});
