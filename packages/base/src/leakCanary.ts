// src/gem/leakCanary.ts
//
// Final, independent safety net before a Gem leaves the machine. `buildGem` already redacts at
// capture (redact.ts), so the canary is defense in depth: it scans the FULLY BUILT Gem for strong
// credential patterns that survived, and fails CLOSED — so an obvious secret can never be published,
// deployed, transferred, or shared even if an upstream redaction path was skipped or regressed.
//
// It reuses the high-precision strong-credential patterns (secretPatterns.ts), NOT generic entropy,
// so scanning the whole Gem (which legitimately contains content hashes / digests) doesn't
// false-positive. A redacted secret is already the `<redacted>` placeholder, so it never trips the net.
import type { Gem } from "@agentgem/model";
import { findStrongCredentials } from "./secretPatterns.js";

export interface LeakFinding {
  kind: string; // "jwt" | "provider-token" | "pem-private-key" | "url-credential"
  artifact: string; // owning artifact name, or "<gem>" for top-level fields
  sample: string; // masked preview (prefix + length), never the raw secret
}

export interface LeakReport {
  ok: boolean;
  findings: LeakFinding[];
}

// Scan a built Gem artifact-by-artifact so each finding points at its owner. Top-level fields
// (name / createdFrom / checks / requiredSecrets) are scanned together under "<gem>".
export function scanGemForLeaks(gem: Gem): LeakReport {
  const findings: LeakFinding[] = [];
  const scan = (artifact: string, text: string) => {
    for (const hit of findStrongCredentials(text)) findings.push({ kind: hit.kind, artifact, sample: hit.sample });
  };
  for (const a of gem.artifacts) scan(a.name, JSON.stringify(a));
  scan(
    "<gem>",
    JSON.stringify({ name: gem.name, createdFrom: gem.createdFrom, checks: gem.checks, requiredSecrets: gem.requiredSecrets }),
  );
  return { ok: findings.length === 0, findings };
}

// Thrown by the fail-closed gate. Carries the (masked) findings so a caller can surface them
// without re-leaking the secret; the message never contains a raw value.
export class GemLeakError extends Error {
  readonly findings: LeakFinding[];
  constructor(findings: LeakFinding[]) {
    super(
      `Refusing to release Gem: ${findings.length} credential-like value(s) survived redaction — ` +
        findings.map((f) => `${f.kind} in ${f.artifact}`).join(", "),
    );
    this.name = "GemLeakError";
    this.findings = findings;
  }
}

// Fail-closed publish/transfer/deploy gate. Call on any path that sends a Gem off the machine;
// throws {@link GemLeakError} if any strong credential survived, otherwise returns silently.
export function assertGemSafe(gem: Gem): void {
  const report = scanGemForLeaks(gem);
  if (!report.ok) throw new GemLeakError(report.findings);
}
