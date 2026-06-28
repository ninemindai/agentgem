// src/gem/__tests__/analysisCache.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptToken } from "../analysisCache.js";

describe("transcriptToken", () => {
  it("is versioned so a distillation rollout invalidates pre-distill entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "tok-"));
    const f = join(dir, "s.jsonl");
    writeFileSync(f, "{}");
    expect(transcriptToken([f]).startsWith("v3:")).toBe(true);
  });

  it("changes when a transcript is updated", () => {
    const dir = mkdtempSync(join(tmpdir(), "tok2-"));
    const f = join(dir, "s.jsonl");
    writeFileSync(f, "{}");
    const before = transcriptToken([f]);
    utimesSync(f, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    expect(transcriptToken([f])).not.toBe(before);
  });
});
