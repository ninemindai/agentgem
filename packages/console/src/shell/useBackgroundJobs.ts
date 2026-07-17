// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Composes the two existing transient background signals — warm cache status
// (WarmingPill's endpoint) and the dream pass/queue (Dreaming's own getStatus) —
// into the ONE poll the rail footer's status line and the "Review inbox" rail
// entry both read from. Mounted once in Shell; no new endpoints, no persistence.
import { useEffect, useState } from "react";
import { getStatus as getDreamStatus, type DreamStatus } from "../panels/Dreaming/api.js";

/** Matches the WarmingPill.tsx shape — same endpoint, same fields it already reads. */
export interface WarmStatusShape {
  running: boolean;
  progress: { phase: string | null } | null;
  last: { finishedAt: number } | null;
}

export interface JobRow { id: string; label: string; route: string }
export type BackgroundMode = "active" | "idle" | "off";

export interface BackgroundJobs {
  mode: BackgroundMode;
  count: number;
  jobs: JobRow[];
  /** Dream queue count — drives the rail's "Review inbox" entry. */
  inboxCount: number;
}

export const BACKGROUND_POLL_MS = 5000;

async function fetchWarm(apiBase: string): Promise<WarmStatusShape | null> {
  try {
    const r = await fetch(`${apiBase}/api/warm/status`);
    if (!r.ok) return null;
    return (await r.json()) as WarmStatusShape;
  } catch {
    return null; // best-effort — a failed poll leaves the last snapshot in place
  }
}

export function useBackgroundJobs(apiBase: string): BackgroundJobs {
  const [warm, setWarm] = useState<WarmStatusShape | null>(null);
  const [dream, setDream] = useState<DreamStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      void fetchWarm(apiBase).then((w) => { if (alive && w) setWarm(w); });
      void getDreamStatus(apiBase).then((d) => { if (alive) setDream(d); }).catch(() => { /* best-effort */ });
    };
    poll();
    const h = setInterval(poll, BACKGROUND_POLL_MS);
    return () => { alive = false; clearInterval(h); };
  }, [apiBase]);

  const warmRunning = warm?.running === true;
  const dreamRunning = dream?.progress != null;

  // Off vs idle: /api/warm/status never says WHY it's at rest. AGENTGEM_WARM=off means
  // startWarmSchedule() is never called, so `status` never leaves its boot default
  // ({running:false, last:null}) — see src/warm/schedule.ts + orchestrator.ts. A
  // warming-ENABLED server reads identically for the instant before its boot pass
  // completes, which we can't tell apart from here. That transient false-negative is
  // the honest cost of composing only what the endpoint exposes, not fabricating a
  // dedicated "off" signal.
  const warmOff = warm != null && !warmRunning && warm.last == null;

  const jobs: JobRow[] = [];
  if (warmRunning) {
    jobs.push({
      id: "warm",
      label: warm?.progress?.phase ? `Precomputing background caches — ${warm.progress.phase}` : "Precomputing background caches",
      route: "#/optimize",
    });
  } else if (warm?.last) {
    jobs.push({ id: "warm", label: "Background caches warm", route: "#/optimize" });
  }
  if (dreamRunning) {
    jobs.push({
      id: "dream",
      label: dream?.progress?.phase ? `Dreaming — ${dream.progress.phase}` : "Dreaming",
      route: "#/dreaming",
    });
  } else if ((dream?.queued ?? 0) > 0) {
    jobs.push({ id: "dream", label: `${dream!.queued} item${dream!.queued === 1 ? "" : "s"} awaiting review`, route: "#/dreaming" });
  }

  const count = (warmRunning ? 1 : 0) + (dreamRunning ? 1 : 0);
  const mode: BackgroundMode = count > 0 ? "active" : warmOff ? "off" : "idle";

  return { mode, count, jobs, inboxCount: dream?.queued ?? 0 };
}
