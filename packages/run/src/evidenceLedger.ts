// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The local verification-evidence ledger: one JSONL line per verified Gem run,
// under AGENTGEM_HOME. Append-only, local-only (nothing uploads it), best-effort —
// this is an observability substrate for the cross-agent matrix and the journey
// timeline, never a gate: an IO failure must not fail the run that produced it.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger } from "@agentgem/base";
import { agentgemHome } from "@agentgem/model";
import type { VerificationReport } from "./gemVerify.js";

const log = createLogger("run");

export interface VerificationRecord {
  ts: string;                          // ISO timestamp, stamped at append
  gemName?: string;
  gemDigest?: string;                  // lock digest — verdicts key on content, not name
  agent: string;
  adapterVersion?: string;
  contractApplied: boolean;            // expectations came from the Gem's contract, not the caller
  run: { ok: boolean; toolCalls: number };
  verification: VerificationReport;
}

export function ledgerPath(home?: string): string {
  return join(home ?? agentgemHome(), ".agentgem", "verifications.jsonl");
}

export function appendVerification(rec: Omit<VerificationRecord, "ts">, home?: string): void {
  try {
    const path = ledgerPath(home);
    mkdirSync(dirname(path), { recursive: true });
    const full: VerificationRecord = { ts: new Date().toISOString(), ...rec };
    appendFileSync(path, JSON.stringify(full) + "\n", "utf8");
  } catch (err) {
    log.error("evidence-ledger append failed: %s", (err as Error).message);
  }
}
