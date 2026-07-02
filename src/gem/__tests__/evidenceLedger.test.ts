import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendVerification, ledgerPath } from "@agentgem/run";

const rec = {
  gemName: "g",
  gemDigest: "sha256:abc",
  agent: "claude",
  adapterVersion: "0.51.0",
  contractApplied: true,
  run: { ok: true, toolCalls: 2 },
  verification: { passed: true, checks: [{ name: "no tool failures", passed: true, detail: "all tools ok" }] },
};

describe("evidence ledger", () => {
  it("appends one parseable JSONL record per call, stamping ts", () => {
    const home = mkdtempSync(join(tmpdir(), "agem-ledger-"));
    try {
      appendVerification(rec, home);
      appendVerification({ ...rec, contractApplied: false }, home);
      const lines = readFileSync(ledgerPath(home), "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]);
      expect(first.gemName).toBe("g");
      expect(first.verification.passed).toBe(true);
      expect(new Date(first.ts).getTime()).toBeGreaterThan(0); // valid ISO timestamp
      expect(JSON.parse(lines[1]).contractApplied).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never throws when the ledger is unwritable (best-effort)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agem-ledger-"));
    const fileAsHome = join(dir, "not-a-dir");
    writeFileSync(fileAsHome, "occupied"); // home path is a FILE → appendFile fails
    try {
      expect(() => appendVerification(rec, fileAsHome)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
