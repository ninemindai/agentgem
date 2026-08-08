// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/reportChecks.ts
//
// Checks specific to the long-form editorial report (REPORT_BUILDER_BRIEF / reportRender.ts). They
// compose with SHARED_CHECKS rather than replacing them.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A GREEN RESULT HERE DOES AND DOES NOT MEAN — read before trusting it.
//
// The brief's central rule is that every number reaches the page THROUGH the embedded
// `#report-data` JSON, never through prose the agent typed. That is the anti-hallucination seam.
//
// These checks establish that the seam EXISTS, PARSES, and IS NON-EMPTY.
//
// They do NOT establish that the rendered numbers came from it. A report can carry a perfectly valid
// `#report-data` block and still hardcode every figure in prose beside it; nothing here would notice.
// Verifying that would mean comparing rendered text against the parsed facts, which is a different
// and much larger job (out of scope — see the render-verification-gate design).
//
// So: a green result means "the seam is intact", NOT "the report is honest". Do not let a dashboard,
// a summary line, or a commit message upgrade the first claim into the second.
// ─────────────────────────────────────────────────────────────────────────────
import type { Check, Finding, RenderDigest } from "@ninemind/miniapp-gate";

/** The id REPORT_BUILDER_BRIEF requires on the embedded facts block. */
export const REPORT_DATA_ID = "report-data";

const seamOf = (d: RenderDigest) => d.jsonBlocks.find((b) => b.id === REPORT_DATA_ID);

// ONE finding per seam problem, never a cascade. A missing seam is not additionally "unparseable"
// and "empty" — three findings for one cause would make the repair prompt argue with itself about
// which thing to fix.
const reportDataSeam: Check = (d) => {
  const seam = seamOf(d);
  if (!seam) {
    return [{
      id: "report-data-missing",
      severity: "fail",
      message: `The report has no <script type="application/json" id="${REPORT_DATA_ID}"> block. Every number on the page is then prose rather than a value read from the facts. Bake the FACTS verbatim into that block and render from it.`,
    }];
  }
  if (!seam.parses) {
    return [{
      id: "report-data-unparseable",
      severity: "fail",
      message: `The ${REPORT_DATA_ID} block is present but is not valid JSON, so nothing can read from it. Escape "<" as \\u003c and re-emit the FACTS verbatim.`,
      evidence: `${seam.bytes} bytes`,
    }];
  }
  if (seam.empty) {
    return [{
      id: "report-data-empty",
      severity: "fail",
      message: `The ${REPORT_DATA_ID} block parses to nothing, so the report cannot be reading its numbers from it. Bake the FACTS in.`,
      evidence: `${seam.bytes} bytes`,
    }];
  }
  return [];
};

const noTitle: Check = (d) =>
  (d.title ?? "").trim() !== "" ? [] : [{
    id: "no-title",
    severity: "warn",
    message: "The document has no <title>, so a browser tab or a shared link shows a filename instead of the report's subject.",
  }];

/** Digest-derived report checks. Compose with SHARED_CHECKS. */
export const REPORT_CHECKS: Check[] = [reportDataSeam, noTitle];

/** NOT a Check: truncation is a property of the RENDER, not of the DOM, so no digest can carry it.
 *
 *  It is a `fail` because the slice is byte-wise and blind — it can cut through the middle of the
 *  `#report-data` object, leaving a document that looks complete and whose seam no longer parses.
 *  Lives here so every report finding is discoverable in one module. */
export function reportTruncatedFinding(producedBytes: number, maxBytes: number): Finding {
  return {
    id: "report-truncated",
    severity: "fail",
    message: `The report exceeded the size budget and was cut, which can sever the ${REPORT_DATA_ID} block mid-object. Summarize per-item rows instead of growing unbounded.`,
    evidence: `${producedBytes} bytes produced, budget ${maxBytes}`,
  };
}

/** Every id this module can emit — for drift guards and UI enumeration. */
export const REPORT_CHECK_IDS = [
  "report-data-missing",
  "report-data-unparseable",
  "report-data-empty",
  "report-truncated",
  "no-title",
] as const;
