// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Decide WHICH session a replay's session-data feed should load. Default = the miniapp's own recorded
// (author) session. A viewer OVERRIDE (sessionId + agent) is honored ONLY when it names one of the
// host's currently-enumerated local sessions — so a crafted client can never coerce the route into
// loading an arbitrary transcript. A partial override (only one field) is ignored.
import type { GameSource } from "@agentgem/model";

export interface SessionRef { sessionId: string; agent: string }

export function resolveSessionRef(
  createdFrom: GameSource,
  override: { sessionId?: string; agent?: string },
  active: { id: string; agent: string }[],
): SessionRef {
  if (override.sessionId && override.agent) {
    const ok = active.some((s) => s.id === override.sessionId && s.agent === override.agent);
    if (!ok) throw new Error(`session '${override.sessionId}' is not an available local session`);
    return { sessionId: override.sessionId, agent: override.agent };
  }
  if (createdFrom.kind !== "session") throw new Error("this miniapp has no session data");
  return { sessionId: createdFrom.sessionId, agent: createdFrom.agent };
}
