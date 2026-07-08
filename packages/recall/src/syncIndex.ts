// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Keep the RecallIndex current against the live session set. Incremental: a
// session's change stamp is (endMs:msgs) — appending to a transcript grows both,
// so we re-index only what changed and prune what vanished. `loadTranscript` is
// injected (real: insight.loadSessionTranscript) so this is testable without fs.
import type { SessionStat, TranscriptView } from "@agentgem/insight";
import { RecallIndex } from "./recallIndex.js";
import { chunkTranscript } from "./chunkTranscript.js";

export interface SyncDeps {
  loadTranscript(sessionId: string, agent: string): Promise<TranscriptView | null>;
}

export function stampOf(stat: SessionStat): string { return `${stat.endMs}:${stat.msgs}`; }

export async function syncRecallIndex(
  index: RecallIndex, sessions: SessionStat[], deps: SyncDeps,
): Promise<{ indexed: number; skipped: number; removed: number }> {
  const have = index.indexedSessions();
  let indexed = 0, skipped = 0;
  for (const s of sessions) {
    const key = `${s.agent}:${s.sessionId}`;
    const stamp = stampOf(s);
    if (have.get(key) === stamp) { have.delete(key); continue; } // unchanged
    const view = await deps.loadTranscript(s.sessionId, s.agent);
    if (!view) { skipped++; have.delete(key); continue; }        // unparseable — leave as-is / drop key
    index.upsertSession(
      { sessionId: s.sessionId, agent: s.agent, project: s.project, branch: s.gitBranch, startMs: s.startMs },
      chunkTranscript(view), stamp,
    );
    indexed++; have.delete(key);
  }
  // Anything still in `have` was indexed before but is no longer present → prune.
  let removed = 0;
  for (const key of have.keys()) {
    const [agent, ...rest] = key.split(":");
    index.deleteSession(agent, rest.join(":"));
    removed++;
  }
  return { indexed, skipped, removed };
}
