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
}
export interface ReportRenderResult { html: string; ok: boolean; truncated?: boolean }

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
const EXEMPLAR_BLOCK =
  `## Worked example — imitate this STRUCTURE and its \`#report-data\` wiring (every number read from the ` +
  `embedded JSON via textContent, never typed into prose). Do NOT copy its numbers, subject or advice; ` +
  `those come from your FACTS:\n\n` +
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
  let conn: { ctx: AcpCtx; close: () => void } | null = null;
  let handle: AcpSessionHandle | null = null;
  const t0 = Date.now();
  try {
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    conn = await withTimeout(connectFn(taskAgent("report"), null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());
    await withTimeout(handle.setMode("plan"), left());
    const text = await withTimeout(handle.promptText(buildReportPrompt(input), input.onDelta), left());
    const html = extractHtml(text);
    if (!html) return { html: "", ok: false };
    log.debug("report: rendered in %dms (%d bytes)", Date.now() - t0, html.length);
    return { html: html.slice(0, MAX_REPORT_HTML), ok: true, truncated: html.length > MAX_REPORT_HTML };
  } catch (err) {
    log.warn("report: failed after %dms: %s", Date.now() - t0, (err as Error)?.message ?? err);
    return { html: "", ok: false };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}
