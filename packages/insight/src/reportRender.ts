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
  CLAUDE_AGENT, analysisWorkspace, currentTestConnectFn, defaultConnectFn,
} from "./acpRecommender.js";
import { extractHtml } from "./dashboardRender.js";
import { REPORT_BUILDER_BRIEF } from "./reportBrief.js";
import { createLogger } from "@agentgem/base";

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
}
export interface ReportRenderResult { html: string; ok: boolean; truncated?: boolean }

export function buildReportPrompt(input: ReportRenderInput): string {
  return (
    `${REPORT_BUILDER_BRIEF}\n` +
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
    conn = await withTimeout(connectFn(CLAUDE_AGENT, null), left());
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
