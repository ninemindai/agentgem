// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import type { RecallIndex } from "@agentgem/recall";
import type { MemoryProvider, ProviderConfig } from "./types.js";
import { readCursor, writeCursor } from "./cursors.js";

/**
 * Pull memories from `provider` (incrementally, from the stored cursor) and
 * upsert each into the recall index as a one-chunk pseudo-session under the
 * `memory:<provider>` agent namespace. Advances the cursor to the newest
 * `updatedAt` seen. Returns how many memories were written.
 */
export async function pullIntoRecall(
  provider: MemoryProvider,
  cfg: ProviderConfig,
  index: RecallIndex,
): Promise<{ pulled: number }> {
  const agent = `memory:${provider.id}`;
  const since = readCursor(provider.id);
  let pulled = 0;
  let maxSeen = since ?? 0;

  for await (const rec of provider.pull(cfg, since)) {
    index.upsertSession(
      { sessionId: rec.id, agent, project: (rec.metadata?.project as string) ?? null, branch: null, startMs: rec.updatedAt },
      [{ turn: 0, text: rec.text }],
      String(rec.updatedAt),
    );
    pulled++;
    if (rec.updatedAt > maxSeen) maxSeen = rec.updatedAt;
  }

  if (pulled > 0) writeCursor(provider.id, maxSeen);
  return { pulled };
}
