// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/dashboardRender.ts
//
// Flavor B rendering agent: evolve a living HTML dashboard of a running session.
// Given the previous dashboard HTML and the NEW events since it was rendered, drive
// the ACP agent (plan mode) to return an updated, self-contained HTML document.
// Mirrors narrateInsights: never throws — returns the last-good HTML on any failure.
import {
  type AcpConnectFn, type AcpCtx, type AcpSessionHandle,
  CLAUDE_AGENT, analysisWorkspace, currentTestConnectFn, defaultConnectFn,
} from "./acpRecommender.js";
import type { SessionEvent } from "./inspectSession.js";
import type { AgentId } from "./observeAggregate.js";
import { createLogger } from "@agentgem/base";

const log = createLogger("insight");
export const MAX_HTML = 80_000;

// acpRecommender does NOT export withTimeout (it's file-private there); define our own,
// same shape as narrateInsights.ts (eng-review outside-voice #1).
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`agent timeout after ${ms}ms`)), ms))]);
}

export interface RenderInput {
  prevHtml: string;
  deltaEvents: SessionEvent[];
  meta: { project: string | null; agent: AgentId };
  connectFn?: AcpConnectFn;
  timeoutMs?: number;
}
export interface RenderResult { html: string; ok: boolean; truncated?: boolean; }

// The visual contract (anti-slop). Kept terse; the agent gets the palette + rules and
// the compact exemplar so it matches the AgentGem console rather than a generic panel.
const EXEMPLAR =
  `<section style="font-family:'Fraunces',Georgia,serif;background:#f1eadb;color:#20190f;padding:18px 20px">` +
  `<h2 style="margin:0;font-size:16px">acme-web</h2>` +
  `<p style="font-family:'Hanken Grotesk',sans-serif;color:#463d2c;font-size:13px;margin:2px 0 16px">Building the hero, then the build</p>` +
  `<div style="border-left:3px solid #9a3324;background:#fbeee9;padding:8px 12px;border-radius:0 6px 6px 0;margin-bottom:16px">` +
  `<div style="font:600 11px/1 sans-serif;letter-spacing:.07em;text-transform:uppercase;color:#9a3324">Now</div>` +
  `<code style="font-family:ui-monospace,Menlo,monospace;font-size:13px">$ npm run build</code></div>` +
  `<ul style="list-style:none;margin:0;padding:0;font-family:'Hanken Grotesk',sans-serif;font-size:13px">` +
  `<li>Read index.html · done</li><li>Edit hero · done</li><li>Bash npm run build · running</li></ul></section>`;

function buildPrompt(input: RenderInput): string {
  const events = JSON.stringify(input.deltaEvents.map((e) => e.span));
  const prev = input.prevHtml ? input.prevHtml : "(none — this is the first render)";
  const project = input.meta.project ?? "this session";
  return (
    `You render a LIVE dashboard of a running ${input.meta.agent} coding-agent session, for the AgentGem console.\n` +
    `SESSION: project "${project}" (agent: ${input.meta.agent}). Put the project name in the dashboard header — do not use a placeholder.\n` +
    `PREVIOUS DASHBOARD HTML:\n${prev}\n\n` +
    `NEW EVENTS since it was rendered (JSON):\n${events}\n\n` +
    `Return ONE self-contained HTML document that EVOLVES the previous dashboard in place to reflect the new events. ` +
    `Rules: inline <style> only, NO external resources (no CDN/fonts/img/scripts). ` +
    `Match this palette and composition EXACTLY — do not invent a generic SaaS look:\n` +
    `- surface #f1eadb, ink #20190f, ONE accent #9a3324 (terracotta), #2f6b3a only for done/success\n` +
    `- serif headings, monospace for file paths and shell commands\n` +
    `- ONE visual anchor (current activity); a vertical timeline, NOT a card grid; no gradients, no drop shadows, no emoji\n` +
    `- COMPACT: must fit ~560px tall with no internal scrollbar. Summarize rather than grow.\n` +
    `EXAMPLE of the target look:\n${EXEMPLAR}\n\n` +
    `Return ONLY the HTML (a { "html": "…" } wrapper is also accepted). No prose, no code fences.`
  );
}

/** Pull an HTML document out of the agent reply: unwrap a {html} JSON wrapper, else
 *  trim to the outermost markup. Returns null when there is no markup at all. */
export function extractHtml(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    try { const o = JSON.parse(s); if (o && typeof o.html === "string" && o.html.trim()) return o.html; } catch { /* not json */ }
  }
  const lower = s.toLowerCase();
  const start = ((): number => {
    const d = lower.indexOf("<!doctype");
    if (d >= 0) return d;
    const h = lower.indexOf("<html");
    if (h >= 0) return h;
    return s.indexOf("<");
  })();
  const end = s.lastIndexOf(">");
  if (start < 0 || end <= start) return null;
  const html = s.slice(start, end + 1);
  return /<[a-z!][\s\S]*>/i.test(html) ? html : null;
}

export async function renderDashboard(input: RenderInput): Promise<RenderResult> {
  const connectFn = input.connectFn ?? currentTestConnectFn() ?? defaultConnectFn;
  const timeoutMs = input.timeoutMs ?? 60_000;
  let conn: { ctx: AcpCtx; close: () => void } | null = null;
  let handle: AcpSessionHandle | null = null;
  const t0 = Date.now();
  try {
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    conn = await withTimeout(connectFn(CLAUDE_AGENT, null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());
    await withTimeout(handle.setMode("plan"), left());
    const text = await withTimeout(handle.promptText(buildPrompt(input)), left());
    const html = extractHtml(text);
    if (!html) return { html: input.prevHtml, ok: false };
    log.debug("dashboard: rendered in %dms (%d bytes)", Date.now() - t0, html.length);
    // Truncate before emit (cap the untrusted doc), and flag it so the endpoint forces a
    // full-regenerate next burst rather than evolving a clipped document (eng-review Q2 + #7).
    return { html: html.slice(0, MAX_HTML), ok: true, truncated: html.length > MAX_HTML };
  } catch (err) {
    log.warn("dashboard: fell back after %dms: %s", Date.now() - t0, (err as Error)?.message ?? err);
    return { html: input.prevHtml, ok: false };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}
