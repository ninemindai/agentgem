// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Publish invariant: a shared miniapp must render with NO host. app.agentgem.ai plays games in a sealed
// iframe with no capability broker, so a game that depends on a host-brokered content feed would sit
// empty there. Content-critical capabilities must therefore ship a baked, self-contained fallback.
import type { GameCapability } from "@agentgem/model";

export interface PortabilityResult { ok: boolean; failures: string[] }

// Caps whose data IS the game's primary content (so it must be baked to run offline). The privileged /
// live caps (invoke-agent, live-session-events, local-project-access) are local-only by design and are
// intentionally NOT in this list — a game may use them as an enhancement over a baked default.
const CONTENT_CAPS: readonly GameCapability[] = ["session-data"];

export function assertPortable(html: string, needs: GameCapability[] | undefined): PortabilityResult {
  const failures: string[] = [];
  const declaresContentCap = (needs ?? []).some((c) => CONTENT_CAPS.includes(c));
  if (declaresContentCap && !hasBakedTimeline(html)) {
    failures.push("declares session-data but bakes no fallback data — it would not run without a host (e.g. on app.agentgem.ai)");
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
