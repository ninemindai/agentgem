// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Discover (Optimize Plan 2, Stage 2): optionally re-rank the Stage-1 candidates by
// semantic relevance using a local ACP coding agent (plan mode, permissions denied),
// reusing the acpRecommender façade. The agent may ONLY reorder/re-reason the items
// it was given — anything outside the input set is dropped, and any failure degrades
// to the Stage-1 order. Never throws. Token-costing — invoked behind an explicit UI button.
import { CLAUDE_AGENT, analysisWorkspace, defaultConnectFn, currentTestConnectFn, type AcpConnectFn, type AcpCtx, type AcpSessionHandle } from "./acpRecommender.js";
import type { DiscoverCandidate, DiscoverPayload } from "./discover.js";

const key = (source: string, name: string) => `${source}\n${name}`;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`agent timeout after ${ms}ms`)), ms))]);
}

function prompt(candidates: DiscoverCandidate[], topics: string[]): string {
  const list = candidates.map((c, i) =>
    `${i}. ${c.source}@${c.name} (${c.installs ?? 0} installs) — ${c.reason}`).join("\n");
  return (
    `Rank these candidate agent "skills" by relevance to the user's active workflows.\n` +
    `User workflow topics: ${topics.join(", ")}.\n` +
    `Candidates (source@name):\n${list}\n\n` +
    `Return ONLY JSON: {"order":[{"source","name","reason"}]}, most relevant first. ` +
    `Use ONLY the exact source/name pairs above — never invent. ` +
    `"reason" is one short clause on why it fits the user's workflows.`
  );
}

function extractJson(text: string): string {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  return s >= 0 && e > s ? text.slice(s, e + 1) : text;
}

/** Validate the agent reply against the input set; append any items the agent omitted. */
function applyOrder(raw: string, input: DiscoverCandidate[]): DiscoverCandidate[] | null {
  let obj: unknown;
  try { obj = JSON.parse(extractJson(raw)); } catch { return null; }
  const order = (obj as { order?: unknown })?.order;
  if (!Array.isArray(order)) return null;
  const byKey = new Map(input.map((c) => [key(c.source, c.name), c]));
  const used = new Set<string>();
  const out: DiscoverCandidate[] = [];
  for (const o of order) {
    const source = (o as { source?: unknown })?.source;
    const name = (o as { name?: unknown })?.name;
    if (typeof source !== "string" || typeof name !== "string") continue;
    const k = key(source, name);
    const hit = byKey.get(k);
    if (!hit || used.has(k)) continue;
    used.add(k);
    const reason = (o as { reason?: unknown })?.reason;
    out.push(typeof reason === "string" && reason ? { ...hit, reason } : hit);
  }
  if (!out.length) return null;
  for (const c of input) if (!used.has(key(c.source, c.name))) out.push(c); // never lose a recommendation
  return out;
}

export async function rerankCandidates(
  input: { candidates: DiscoverCandidate[]; topics: string[] },
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number } = {},
): Promise<DiscoverPayload> {
  if (input.candidates.length <= 1) return { ...input, reranked: false };
  const connectFn = opts.connectFn ?? currentTestConnectFn() ?? defaultConnectFn;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let conn: { ctx: AcpCtx; close: () => void } | null = null;
  let handle: AcpSessionHandle | null = null;
  try {
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    conn = await withTimeout(connectFn(CLAUDE_AGENT, null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());
    await withTimeout(handle.setMode("plan"), left());
    const text = await withTimeout(handle.promptText(prompt(input.candidates, input.topics)), left());
    const ordered = applyOrder(text, input.candidates);
    if (!ordered) return { ...input, reranked: false, degraded: { reason: "AI re-rank returned no usable order; showing default order." } };
    return { candidates: ordered, topics: input.topics, reranked: true };
  } catch (err) {
    console.error("discover: re-rank fell back to default order:", (err as Error).message);
    return { ...input, reranked: false, degraded: { reason: "AI re-rank unavailable; showing default order." } };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}
