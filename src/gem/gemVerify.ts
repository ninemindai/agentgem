// src/gem/gemVerify.ts
//
// The verification surface: given the outcome of runGemWithAgent, decide whether a
// Gem actually did its job. This is the marketplace trust primitive ("✓ verified").
//
// Verification is deliberately BEHAVIOR-based and tolerant, never exact-output:
// agent runs are non-deterministic, so we assert that the right tools were invoked
// and nothing failed — not that the transcript matched a golden string. Asserting
// exact output would make every verification flaky and is the wrong question.
import type { GemRunOutcome } from "./acpRun.js";

export interface GemExpectations {
  // Each entry must (case-insensitively, as a substring) match the title of some
  // invoked tool — e.g. a bundled skill name, "Write", "Bash".
  expectTools?: string[];
  // The assembled agent text must contain this substring / match this regex.
  expectText?: string | RegExp;
  // When true (default), the run fails verification if any tool ended "failed".
  forbidToolFailures?: boolean;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerificationReport {
  passed: boolean;
  checks: VerificationCheck[];
}

export function verifyGemRun(outcome: GemRunOutcome, expectations: GemExpectations = {}): VerificationReport {
  // A run that never completed can't be reasoned about — fail fast, single check.
  if (!outcome.ok) {
    return { passed: false, checks: [{ name: "run completed", passed: false, detail: outcome.error ?? "run did not complete" }] };
  }

  const checks: VerificationCheck[] = [];
  const { toolCalls, text } = outcome.result;
  const titles = toolCalls.map((t) => t.title);

  for (const want of expectations.expectTools ?? []) {
    const hit = titles.some((title) => title.toLowerCase().includes(want.toLowerCase()));
    checks.push({
      name: `invoked tool ~ "${want}"`,
      passed: hit,
      detail: hit ? `matched ${JSON.stringify(titles.find((t) => t.toLowerCase().includes(want.toLowerCase())))}` : `no invoked tool matched (saw: ${titles.length ? titles.join(", ") : "none"})`,
    });
  }

  if (expectations.expectText !== undefined) {
    const pat = expectations.expectText;
    const hit = typeof pat === "string" ? text.includes(pat) : pat.test(text);
    checks.push({
      name: "output text matches",
      passed: hit,
      detail: hit ? "matched" : `expected ${typeof pat === "string" ? JSON.stringify(pat) : String(pat)} in agent output`,
    });
  }

  if (expectations.forbidToolFailures ?? true) {
    const failed = toolCalls.filter((t) => t.status === "failed").map((t) => t.title);
    checks.push({
      name: "no tool failures",
      passed: failed.length === 0,
      detail: failed.length === 0 ? "all tools ok" : `failed tools: ${failed.join(", ")}`,
    });
  }

  return { passed: checks.every((c) => c.passed), checks };
}
