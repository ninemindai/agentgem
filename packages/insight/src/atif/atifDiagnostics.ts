// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Import diagnostics for the ATIF drop-dir on-ramp. The drop dir is the one
// ingestion surface whose input is authored by someone other than us (Harbor
// converters, third-party exporters), and until now a file that failed to parse
// vanished from the scan with no trace: parseAtifDocument collapses five
// distinct rejection reasons into one null, and scanAtifSessions just skipped it.
//
// These are OBSERVATION ONLY — no control flow depends on them, and the parsers
// keep their total-function contract (null/[] on bad input, never throw).
// Collection is opt-in via an optional trailing collector argument, so
// SourceSpec.parseMeta and the other six sources are untouched.
//
// PRIVACY: a diagnostic carries a code, the file path, a step id, and a count.
// It NEVER carries transcript content — no offending substrings, no tool names,
// no JSON excerpts. parseAtifMeta promises to keep no text (see atifImport.ts);
// a diagnostics channel that leaked content would quietly break that promise.

import { basename } from "node:path";

/** Codes are derived from the failure paths this parser actually has. */
export type AtifDiagnosticCode =
  // ── Whole-file rejections: the file is dropped from the scan entirely ──
  | "invalid_json"              // JSON.parse threw
  | "not_an_object"             // valid JSON, but not a JSON object
  | "unknown_schema_version"    // absent, or not "ATIF-v*" (e.g. a foreign format)
  | "missing_agent"             // no agent block, or agent.name is not a string
  | "no_steps"                  // steps absent, not an array, or empty
  // ── Per-step degradations: the file imports, but something was lossy ──
  | "timestamps_missing"        // no step carried a parseable timestamp
  | "orphan_tool_result";       // observation result with no source_call_id

export interface AtifDiagnostic {
  code: AtifDiagnosticCode;
  /** The drop-dir file the diagnostic is about. */
  path: string;
  /** The offending step, when the diagnostic is step-scoped. */
  stepId?: number;
  /** How many occurrences this entry collapses. Absent means one. */
  count?: number;
  /**
   * The rejected `schema_version` for `unknown_schema_version` only, and only
   * when it matches a conservative identifier shape. Anything else is omitted
   * rather than truncated — a malformed version string is exactly the kind of
   * field that could carry arbitrary text.
   */
  schemaVersion?: string;
}

/** A collector is just an array the parsers push into. Optional everywhere. */
export type AtifDiagnostics = AtifDiagnostic[];

const SAFE_SCHEMA_VERSION = /^[A-Za-z0-9._-]{1,32}$/;

/** The subset of a rejected schema_version that is safe to report verbatim. */
export function safeSchemaVersion(v: unknown): string | undefined {
  return typeof v === "string" && SAFE_SCHEMA_VERSION.test(v) ? v : undefined;
}

/**
 * Record one occurrence. Repeats of the same (code, path, stepId) collapse into
 * a `count` rather than appending — a trajectory with 400 unpaired tool results
 * should produce one entry, not 400.
 */
export function pushDiagnostic(diags: AtifDiagnostics | undefined, d: AtifDiagnostic): void {
  if (!diags) return;
  const prior = diags.find((x) => x.code === d.code && x.path === d.path && x.stepId === d.stepId);
  if (prior) { prior.count = (prior.count ?? 1) + 1; return; }
  diags.push(d);
}

/** True when the code means the whole file was dropped from the scan. */
export function isFileRejection(code: AtifDiagnosticCode): boolean {
  return code === "invalid_json" || code === "not_an_object"
    || code === "unknown_schema_version" || code === "missing_agent" || code === "no_steps";
}

/**
 * One line per distinct code, with an occurrence count and a bounded sample of
 * paths. Built for a log sink, so it deliberately says nothing about content.
 */
export function summarizeDiagnostics(diags: AtifDiagnostics, maxPaths = 3): string[] {
  const byCode = new Map<AtifDiagnosticCode, { files: Set<string>; total: number }>();
  for (const d of diags) {
    let e = byCode.get(d.code);
    if (!e) { e = { files: new Set(), total: 0 }; byCode.set(d.code, e); }
    e.files.add(d.path);
    e.total += d.count ?? 1;
  }
  return [...byCode].map(([code, e]) => {
    const paths = [...e.files];
    const shown = paths.slice(0, maxPaths).join(", ");
    const more = paths.length > maxPaths ? ` (+${paths.length - maxPaths} more)` : "";
    const verb = isFileRejection(code) ? "rejected" : "degraded";
    return `${code}: ${e.total} occurrence(s) across ${paths.length} ${verb} file(s) — ${shown}${more}`;
  });
}

export interface AtifHealthFile {
  /** basename only — never an absolute path (privacy: see #538). */
  name: string;
  /** e.g. "step 2" for step-scoped codes; absent for whole-file rejections. */
  detail?: string;
}

export interface AtifHealthGroup {
  code: AtifDiagnosticCode;
  /** isFileRejection(code): drives red (rejected) vs amber (degraded) in the UI. */
  rejection: boolean;
  /** Sum of per-diagnostic counts within this code. */
  occurrences: number;
  /** Distinct offending files, by basename (+ step detail). */
  files: AtifHealthFile[];
}

/**
 * Fold a flat diagnostics array into display-ready groups: one per code, paths
 * reduced to basenames, rejections ordered before degradations. Pure — the FS
 * scan that produces the input lives in ../sources/atif.ts.
 */
export function groupDiagnostics(diags: AtifDiagnostics): AtifHealthGroup[] {
  const byCode = new Map<AtifDiagnosticCode, AtifHealthGroup>();
  for (const d of diags) {
    let g = byCode.get(d.code);
    if (!g) { g = { code: d.code, rejection: isFileRejection(d.code), occurrences: 0, files: [] }; byCode.set(d.code, g); }
    g.occurrences += d.count ?? 1;
    const name = basename(d.path);
    const detail = typeof d.stepId === "number" ? `step ${d.stepId}` : undefined;
    if (!g.files.some((f) => f.name === name && f.detail === detail)) g.files.push({ name, detail });
  }
  // Rejections first (the file was dropped), then degradations. Number(true) - Number(false) = 1.
  return [...byCode.values()].sort((a, b) => Number(b.rejection) - Number(a.rejection));
}
