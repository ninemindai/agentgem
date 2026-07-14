import { describe, it, expect } from "vitest";
import { buildPushCandidates, candidateKey, type RawSignal } from "../candidates.js";

describe("buildPushCandidates", () => {
  it("scrubs, hashes, and dedupes by key", () => {
    const signals: RawSignal[] = [
      { text: "Raymond prefers pnpm", kind: "preference", source: "distill:a" },
      { text: "Raymond prefers pnpm", kind: "preference", source: "distill:b" }, // dup text
    ];
    const out = buildPushCandidates(signals, new Set());
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe(candidateKey(out[0].text));
    expect(out[0].kind).toBe("preference");
  });

  it("drops candidates whose key is already pushed", () => {
    const signals: RawSignal[] = [{ text: "uses vitest", kind: "fact", source: "distill:x" }];
    const key = candidateKey("uses vitest");
    expect(buildPushCandidates(signals, new Set([key]))).toHaveLength(0);
  });

  it("drops empties after scrub", () => {
    const signals: RawSignal[] = [{ text: "   ", kind: "fact", source: "s" }];
    expect(buildPushCandidates(signals, new Set())).toHaveLength(0);
  });
});
