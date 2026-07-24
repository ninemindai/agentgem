// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// ATIF (Agent Trajectory Interchange Format, Harbor RFC 0001) — the subset of
// the v1.x schema AgentGem consumes and emits. Import is tolerant: unknown
// fields ride along untyped, structural violations degrade to null (total-
// function contract, same as observeScan). Spec:
// https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md
import { pushDiagnostic, safeSchemaVersion, type AtifDiagnostic, type AtifDiagnosticCode, type AtifDiagnostics } from "./atifDiagnostics.js";

export interface AtifContentPart {
  type: "text" | "image";
  text?: string;
  source?: { media_type: string; path: string };
}

export interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface AtifObservationResult {
  source_call_id?: string;
  content?: string | AtifContentPart[];
  extra?: Record<string, unknown>;
}

export interface AtifStepMetrics {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cost_usd?: number;
  extra?: Record<string, unknown>;
}

export interface AtifStep {
  step_id: number;
  timestamp?: string;                 // ISO 8601
  source: "system" | "user" | "agent";
  model_name?: string;
  message: string | AtifContentPart[];
  reasoning_content?: string;
  tool_calls?: AtifToolCall[];
  observation?: { results: AtifObservationResult[] };
  metrics?: AtifStepMetrics;
  extra?: Record<string, unknown>;
}

export interface AtifTrajectory {
  schema_version: string;             // "ATIF-v1.7"
  session_id?: string;
  trajectory_id?: string;
  agent: { name: string; version: string; model_name?: string; extra?: Record<string, unknown> };
  steps: AtifStep[];
  notes?: string;
  final_metrics?: {
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_cached_tokens?: number;
    total_cost_usd?: number;
    total_steps?: number;
  };
  extra?: Record<string, unknown>;
}

/** Tolerant parse: null unless it is a JSON object with an ATIF schema_version,
 *  an agent block, and a steps array. Never throws.
 *
 *  `path` and `diags` are optional observation only: when a collector is passed,
 *  each rejection reason is recorded instead of being collapsed into a bare
 *  null. Control flow is identical either way. */
export function parseAtifDocument(text: string, path = "", diags?: AtifDiagnostics): AtifTrajectory | null {
  const reject = (code: AtifDiagnosticCode, extra?: Partial<AtifDiagnostic>): null => {
    pushDiagnostic(diags, { code, path, ...extra });
    return null;
  };
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return reject("invalid_json"); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return reject("not_an_object");
  const d = doc as Record<string, unknown>;
  if (typeof d.schema_version !== "string" || !d.schema_version.startsWith("ATIF-v")) {
    return reject("unknown_schema_version", { schemaVersion: safeSchemaVersion(d.schema_version) });
  }
  const agent = d.agent as Record<string, unknown> | undefined;
  if (!agent || typeof agent.name !== "string") return reject("missing_agent");
  if (!Array.isArray(d.steps) || d.steps.length === 0) return reject("no_steps");
  return d as unknown as AtifTrajectory;
}

/** Flatten a message value (string | ContentPart[]) to one text string; image
 *  parts contribute nothing (paths may be sensitive and are not transcript text). */
export function flattenAtifContent(m: string | AtifContentPart[] | undefined): string {
  if (typeof m === "string") return m;
  if (Array.isArray(m)) {
    return m.map((p) => (p && p.type === "text" && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n");
  }
  return "";
}
