// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/reportRender.ts
//
// Report rendering agent: turn one rubric evaluation (the FACTS) into a
// self-contained editorial HTML readout. Mirrors dashboardRender: plan mode +
// deny permission + neutral analysisWorkspace cwd, the agent returns the HTML
// as text (it never writes files), and any failure degrades to { ok:false } —
// never throws. The authoring contract itself lives in reportBrief.ts
// (dual-shipped as skills/agentgem-report/SKILL.md).
import {
  type AcpConnectFn, type AcpCtx, type AcpSessionHandle,
  analysisWorkspace, currentTestConnectFn, defaultConnectFn,
} from "./acpRecommender.js";
import { extractHtml } from "./dashboardRender.js";
import { REPORT_BUILDER_BRIEF } from "./reportBrief.js";
import { REPORT_EXEMPLAR } from "./reportExemplar.js";
import { HOUSE_TOKENS, themeAdapter, HOUSE_PARTIALS } from "@agentgem/model";
import { createLogger, taskAgent } from "@agentgem/base";
import { gameGate, runChecks, SHARED_CHECKS, type Finding } from "@ninemind/miniapp-gate";
import { REPORT_CHECKS, reportTruncatedFinding } from "./reportChecks.js";

const log = createLogger("insight");

// Matches the byte budget the brief states ("under 120,000 bytes").
export const MAX_REPORT_HTML = 120_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`agent timeout after ${ms}ms`)), ms))]);
}

export interface ReportRenderInput {
  /** The FACTS: a rubric evaluation payload (RubricReport view). Serialized verbatim into the prompt. */
  facts: unknown;
  meta: { rubricId: string; title: string; scope: string };
  connectFn?: AcpConnectFn;
  timeoutMs?: number;
  onDelta?: (chunk: string) => void;
  /** Opt-in: prepend the few-shot REPORT_EXEMPLAR (a full worked report) so the agent imitates its
   *  composition. Off by default — it adds ~3KB to every render. The controller flips it from
   *  AGENTGEM_REPORT_EXEMPLAR. */
  exemplar?: boolean;
  /** Send one follow-up turn when the gate rejects the document. Default true. Tests pin both paths. */
  repair?: boolean;
  /** Injectable clock, for exercising the budget-exhausted path without a 300s test. */
  now?: () => number;
}

/** A DISCRIMINATED UNION, not a flat record with optional fields.
 *
 *  A failed render has no document, so it must not be able to carry an empty `findings` array — that
 *  reads identically to "checked, nothing wrong", and any downstream tally of gate-clean reports
 *  would silently count the renders that never produced anything. The union makes that state
 *  unrepresentable rather than merely discouraged.
 *
 *  The sole consumer already branches on `ok` (gem.controller.ts), so narrowing is free there. */
export type ReportRenderResult =
  | { ok: true; html: string; findings: Finding[]; truncated: boolean }
  | { ok: false; reason: string };

/** Below this much remaining budget, skip the repair turn: a second full document will not finish,
 *  and a half-finished one is worse than the flawed document we already hold. */
const REPAIR_MIN_MS = 20_000;

// The exact CSS behind the brief's theming/typography prose: the shared token vocabulary, the
// document-surface theme binding (data-theme + prefers-color-scheme), and the structural partials a
// report uses (KPI row, data table, inline-SVG bars). Given to the agent verbatim so every
// AgentGem-generated document shares one look instead of each render re-deriving it.
//
// Injected at RUNTIME rather than baked into REPORT_BUILDER_BRIEF on purpose: the brief is byte-mirrored
// into skills/agentgem-report/SKILL.md under a drift guard, so baking the CSS in would force that
// markdown to be regenerated on every houseStyle colour tweak. The constant stays prose; the agent gets
// the bytes.
const HOUSE_STYLE_BLOCK =
  `## House style — put these exact CSS custom properties and rules in your \`<style>\`, and theme every ` +
  `colour, font and metric through them (do not redefine or invent values):\n\n` +
  [HOUSE_TOKENS, themeAdapter("document"), HOUSE_PARTIALS.kpiRow, HOUSE_PARTIALS.dataTable, HOUSE_PARTIALS.svgBar].join("\n") +
  `\n`;

// Opt-in few-shot block. Framed so the agent copies the STRUCTURE and the #report-data wiring — not the
// example's data or subject, which come from the FACTS below.
//
// The "compose, do not compute" clause is a HARDENING: multi-shape A/B evidence showed the exemplar's
// synthesis-forward style could tip the agent into deriving a number (summing two factor counts into a
// "149 instances" total) and typing it into prose — a facts-only violation the brief already forbids in
// general, but which the exemplar's momentum overrode once. This clause re-asserts the rule right next
// to the exemplar, targeting that specific failure.
const EXEMPLAR_BLOCK =
  `## Worked example — imitate this STRUCTURE and its \`#report-data\` wiring (every number read from the ` +
  `embedded JSON via textContent, never typed into prose). Do NOT copy its numbers, subject or advice; ` +
  `those come from your FACTS. Compose, do not compute: state only values present in the FACTS — never ` +
  `sum, total, average or otherwise derive a number the FACTS do not contain (e.g. do not add two factor ` +
  `counts into a combined total). Name the single worst item rather than inventing an aggregate:\n\n` +
  REPORT_EXEMPLAR +
  `\n`;

export function buildReportPrompt(input: ReportRenderInput): string {
  return (
    `${REPORT_BUILDER_BRIEF}\n` +
    `${HOUSE_STYLE_BLOCK}\n` +
    (input.exemplar ? `${EXEMPLAR_BLOCK}\n` : "") +
    `REPORT: "${input.meta.title}" (rubric ${input.meta.rubricId}, scope ${input.meta.scope}). ` +
    `Use that title in the document's eyebrow — never a placeholder.\n\n` +
    `FACTS (JSON):\n${JSON.stringify(input.facts)}\n`
  );
}

/** Render one report. A generous default timeout: a full document is a bigger
 *  ask than the live dashboard's incremental evolve, and the ACP agent inherits the
 *  user's default coding-agent model — which may be a large, slow-to-generate one.
 *  A ~1500-word HTML doc measured at ~68s on a large model; 300s leaves margin for a
 *  full report before we surface a timeout. See fix/agent-timeouts. */
export async function renderReport(input: ReportRenderInput): Promise<ReportRenderResult> {
  const connectFn = input.connectFn ?? currentTestConnectFn() ?? defaultConnectFn;
  const timeoutMs = input.timeoutMs ?? 300_000;
  const now = input.now ?? Date.now;
  let conn: { ctx: AcpCtx; close: () => void } | null = null;
  let handle: AcpSessionHandle | null = null;
  const t0 = now();
  try {
    const deadline = now() + timeoutMs;
    const left = () => Math.max(0, deadline - now());
    conn = await withTimeout(connectFn(taskAgent("report"), null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());
    await withTimeout(handle.setMode("plan"), left());

    const text = await withTimeout(handle.promptText(buildReportPrompt(input), input.onDelta), left());
    const html = extractHtml(text);
    if (!html) return { ok: false, reason: "the agent's reply contained no HTML document" };

    let shipped = await inspect(html);

    // ONE repair turn, on the SAME handle — the agent still holds its own document in context, so
    // "these checks failed, return the corrected document" is a far smaller ask than a fresh render.
    //
    // No onDelta. The first document's chunks have already reached the client and there is no reset
    // protocol on that stream, so a second document streaming in behind the first would corrupt the
    // progress signal. The counter stalls, then the finished document arrives.
    //
    // The budget is SHARED with the first turn, so total wall clock stays bounded by timeoutMs rather
    // than doubling. A slow first render therefore leaves no room, and the report ships unrepaired —
    // the right trade, not a bug.
    const blocking = shipped.findings.filter((f) => f.severity === "fail");
    if (blocking.length && input.repair !== false && left() > REPAIR_MIN_MS) {
      log.debug("report: repairing (%s)", blocking.map((f) => f.id).join(", "));
      try {
        const retry = await withTimeout(handle.promptText(repairPrompt(blocking), undefined), left());
        const repaired = extractHtml(retry);
        // Keep the repair only if it is genuinely better. An agent that returns something worse must
        // not cost the user the document we already had.
        if (repaired) {
          const candidate = await inspect(repaired);
          if (candidate.findings.filter((f) => f.severity === "fail").length < blocking.length) shipped = candidate;
        }
      } catch (err) {
        log.warn("report: repair turn failed, shipping the original: %s", (err as Error)?.message ?? err);
      }
    }

    log.debug("report: rendered in %dms (%d bytes, %d findings)", now() - t0, shipped.html.length, shipped.findings.length);
    return { ok: true, html: shipped.html, findings: shipped.findings, truncated: shipped.truncated };
  } catch (err) {
    const reason = (err as Error)?.message ?? String(err);
    log.warn("report: failed after %dms: %s", now() - t0, reason);
    return { ok: false, reason };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}

/** Slice to the byte budget, then gate the RESULT of that slice.
 *
 *  Order matters and is the whole point: the slice is byte-wise and blind, so it can cut through the
 *  middle of the `#report-data` object. Gating before it would verify a document nobody receives and
 *  return ok on one whose seam the slice then severs. */
async function inspect(produced: string): Promise<{ html: string; findings: Finding[]; truncated: boolean }> {
  const truncated = produced.length > MAX_REPORT_HTML;
  const html = truncated ? produced.slice(0, MAX_REPORT_HTML) : produced;

  const findings: Finding[] = [];
  if (truncated) findings.push(reportTruncatedFinding(produced.length, MAX_REPORT_HTML));

  // scanScope "executable": a report is a document ABOUT code, so `fetch` in a headline is prose, not
  // a call. A genuine fetch() in a script still fails — a report is served with no CSP.
  const gate = await gameGate(html, { digest: true, scanScope: "executable" });
  for (const f of gate.failures) findings.push({ id: "bundle-gate", severity: "fail", message: f });

  if (typeof gate.digest === "string") {
    // "not-requested" cannot happen here (we asked). "not-executed" means the document was never
    // examined — say so rather than returning an empty findings list that reads as clean.
    if (gate.digest === "not-executed" && gate.ok) {
      findings.push({
        id: "render-not-verified",
        severity: "warn",
        message: "The document loaded but could not be inspected, so its checks did not run. Verify it in a browser.",
      });
    }
  } else {
    findings.push(...runChecks(gate.digest, [...SHARED_CHECKS, ...REPORT_CHECKS]));
  }

  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "fail" ? -1 : 1));
  return { html, findings, truncated };
}

/** The repair turn's prompt. Names the failed checks and their messages — the agent cannot act on
 *  "it failed", and these strings are written as repair instructions for exactly this moment. */
function repairPrompt(blocking: Finding[]): string {
  return (
    `The document you just returned failed these checks:\n\n` +
    blocking.map((f) => `- ${f.id}: ${f.message}${f.evidence ? ` (${f.evidence})` : ""}`).join("\n") +
    `\n\nReturn the CORRECTED document in full, same contract as before: only the HTML, no prose, no ` +
    `code fences. Keep everything that was already right.`
  );
}
