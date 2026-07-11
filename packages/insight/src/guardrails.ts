// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/guardrails.ts
//
// Map guardrail DetectorFindings (repeated-tool-error / tool-rejection) into
// coordinates-only GuardrailDrafts destined for the Dream queue. Deterministic,
// no LLM, never throws. detail is built from the finding's low-cardinality text
// only — never from a raw arg (privacy boundary).
import type { WorkflowSignal } from "./workflowScan.js";
import type { Provenance } from "./distillTypes.js";
import { runDetectors, type DetectorFinding, type DetectorSeverity } from "./detectors.js";

const GUARDRAIL_IDS = new Set(["repeated-tool-error", "tool-rejection"]);

export interface GuardrailDraft {
  detectorId: string;
  tool: string;                         // low-cardinality tool name (safe)
  detail: string;                       // scrubbed, human-readable seed text
  confidence: "high" | "medium" | "low";
  occurrences: number;
  provenance: Provenance;
}

const confidenceOf = (severity: DetectorSeverity, occurrences: number): GuardrailDraft["confidence"] =>
  severity === "warn" && occurrences >= 3 ? "high" : severity === "warn" ? "medium" : "low";

export function detectorGuardrails(signal: WorkflowSignal): GuardrailDraft[] {
  const findings = runDetectors(signal).filter((f) => GUARDRAIL_IDS.has(f.detectorId));
  const out: GuardrailDraft[] = [];
  for (const f of findings) {
    const occurrences = f.evidence.msgIndices.length;
    // tool name is the first token of the finding detail ("Bash errored 2x")
    const tool = f.detail.split(" ")[0] ?? "tool";
    out.push({
      detectorId: f.detectorId, tool, detail: f.detail,
      confidence: confidenceOf(f.severity, occurrences), occurrences,
      provenance: { occurrences: [{ sessionId: f.sessionId, transcript: f.transcript, messageIndices: f.evidence.msgIndices, atMs: f.atMs }] },
    });
  }
  return out;
}
