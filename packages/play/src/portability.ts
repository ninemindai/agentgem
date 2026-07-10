// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Publish invariant: a shared miniapp must render with NO host. app.agentgem.ai plays games in a sealed
// iframe with no capability broker, so a game that depends on a host-brokered content feed would sit
// empty there. Content-critical capabilities must therefore ship a baked, self-contained fallback.
import type { GameCapability } from "@agentgem/model";

export interface PortabilityResult { ok: boolean; failures: string[] }

// Total classification of EVERY capability. "content" = its data IS the game's primary content, so it
// must bake a self-contained fallback to run offline (app.agentgem.ai has no capability broker).
// "enhancement" = a local-only upgrade over a baked default (invoke-agent, live-session-events,
// local-project-access) — never blocks publish. Because this Record is keyed by GameCapability, adding a
// new capability to the model union without classifying it here is a COMPILE error: CONTENT_CAPS can
// never silently drift out of sync (a mis-missed content cap would let an empty game publish).
const CAP_CLASS: Record<GameCapability, "content" | "enhancement"> = {
  "session-data": "content",
  "live-session-events": "enhancement",
  "local-project-access": "enhancement",
  "invoke-agent": "enhancement",
  "open-link": "enhancement",            // egress, never a game's primary content
  "send-message": "enhancement",
  "update-model-context": "enhancement",
};

const CONTENT_CAPS: readonly GameCapability[] = (Object.entries(CAP_CLASS) as [GameCapability, "content" | "enhancement"][])
  .filter(([, cls]) => cls === "content")
  .map(([cap]) => cap);

export function assertPortable(html: string, needs: GameCapability[] | undefined): PortabilityResult {
  const failures: string[] = [];
  const contentCaps = (needs ?? []).filter((c) => CONTENT_CAPS.includes(c));
  if (contentCaps.length && !hasBakedTimeline(html)) {
    failures.push(`declares ${contentCaps.join(", ")} but bakes no fallback data — it would not run without a host (e.g. on app.agentgem.ai)`);
  }
  return { ok: failures.length === 0, failures };
}

function hasBakedTimeline(html: string): boolean {
  const m = /<script[^>]*id="game-data"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return false;
  try {
    const d = JSON.parse(m[1] || "{}") as { timeline?: unknown };
    return Array.isArray(d.timeline) && d.timeline.length > 0;
  } catch { return false; }
}
