// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/watchAttention.ts
//
// "Needs your input" detection for the Watch tab: classify each active session as
// pending (an unmatched tool_call with a stalled transcript — likely a permission
// prompt blocking on the user), busy (unmatched call, file still fresh: the tool is
// presumably running), or idle (no unmatched call). The transcript genuinely cannot
// distinguish a permission prompt from a long-running tool, so `pending` is a hedge
// the UI copy carries ("waiting on approval — or a long tool run"), never a claim.
// tool_calls with toolId:null are excluded outright: they are unpairable (see
// SessionFeed.toItems) and counting them would flag a permanent false pending.
import { statSync, readFileSync } from "node:fs";
import type { SessionEvent } from "@agentgem/insight";
import { listActiveSessions, sourceForFile, type ListOpts } from "./watchSessions.js";

export type AttentionState = "pending" | "busy" | "idle";

export interface AttentionInfo {
  state: AttentionState;
  /** Event index of the FIRST unmatched toolId-bearing tool_call (pending only). */
  pendingKey: number | null;
  pendingToolName: string | null;
  stalledMs: number;
}

/** A transcript unwritten for this long with an open tool_call counts as pending. */
export const STALL_MS = 25_000;

export function computeAttention(events: SessionEvent[], mtimeMs: number, now: number): AttentionInfo {
  const open = new Map<string, { index: number; name: string }>();
  for (let i = 0; i < events.length; i++) {
    const span = events[i].span;
    if (span.kind === "tool_call" && span.toolId) open.set(span.toolId, { index: i, name: span.name });
    else if (span.kind === "tool_result" && span.toolId) open.delete(span.toolId);
  }
  const stalledMs = Math.max(0, now - mtimeMs);
  if (open.size === 0) return { state: "idle", pendingKey: null, pendingToolName: null, stalledMs };
  if (stalledMs < STALL_MS) return { state: "busy", pendingKey: null, pendingToolName: null, stalledMs };
  const first = [...open.values()].reduce((a, b) => (a.index <= b.index ? a : b));
  return { state: "pending", pendingKey: first.index, pendingToolName: first.name, stalledMs };
}

export interface AttentionSession {
  id: string;
  file: string;
  agent: string;
  project: string | null;
  state: AttentionState;
  pendingKey: number | null;
  pendingToolName: string | null;
  stalledMs: number;
}

interface FoldCacheEntry { mtimeMs: number; events: SessionEvent[] }

/**
 * Per-instance lister (cache lives in the closure — no module-scoped state).
 * Steady state is cheap: a stalled file's mtime doesn't change, so each poll costs
 * one statSync per session; only a changed file re-folds through detectEvents.
 */
export function createAttentionLister(): (opts?: ListOpts) => AttentionSession[] {
  const cache = new Map<string, FoldCacheEntry>();

  return (opts: ListOpts = {}) => {
    const now = opts.now ?? Date.now();
    const out: AttentionSession[] = [];
    const seen = new Set<string>();

    for (const s of listActiveSessions(opts)) {
      seen.add(s.file);
      const spec = sourceForFile(s.file, opts.baseDir);
      if (!spec?.detectEvents) continue;

      let mtimeMs: number;
      try { mtimeMs = statSync(s.file).mtimeMs; } catch { continue; }

      let entry = cache.get(s.file);
      if (!entry || entry.mtimeMs !== mtimeMs) {
        let text: string;
        try { text = readFileSync(s.file, "utf8"); } catch { continue; }
        entry = { mtimeMs, events: spec.detectEvents(text, s.file) };
        cache.set(s.file, entry);
      }

      const info = computeAttention(entry.events, mtimeMs, now);
      out.push({ id: s.id, file: s.file, agent: s.agent, project: s.project, ...info });
    }

    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key); // aged-out sessions
    return out;
  };
}
