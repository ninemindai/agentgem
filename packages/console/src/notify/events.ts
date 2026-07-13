import { KIND_LABEL } from "../report/kinds.js";

export interface NotifyEvent {
  key: string;
  title: string;
  message: string;
}
export interface WarmSnapshot { running: boolean }
export interface DreamSnapshot { queued: number }

export function detectWarm(prev: WarmSnapshot | null, next: WarmSnapshot): NotifyEvent | null {
  if (prev && prev.running && !next.running) {
    return {
      key: "warm-finished",
      title: "Warm pass finished",
      message: "Insights are freshly precomputed.",
    };
  }
  return null;
}

export function detectDream(prev: DreamSnapshot | null, next: DreamSnapshot): NotifyEvent | null {
  if (prev && next.queued > prev.queued) {
    const n = next.queued - prev.queued;
    return {
      key: "dream-queue",
      title: "New review-queue items",
      message: `${n} new item${n === 1 ? "" : "s"} to review.`,
    };
  }
  return null;
}

export interface ReportSnapshot {
  terminal: Record<string, "done" | "failed">;   // run id -> terminal status
  kindOf: Record<string, string>;                 // run id -> kind
}


// One NotifyEvent per run that became terminal since `prev`. On the FIRST snapshot
// (prev === null) we normally stay silent, EXCEPT for a run that started after the
// provider mounted (firstBaselineAt) — that's an instant cached run that finished
// before the first poll and would otherwise be swallowed (#6).
export function detectReportDone(
  prev: ReportSnapshot | null,
  next: ReportSnapshot,
  opts?: { firstBaselineAt?: number; startedAt?: Record<string, number> },
): NotifyEvent[] {
  const out: NotifyEvent[] = [];
  for (const [id, status] of Object.entries(next.terminal)) {
    if (prev) {
      if (prev.terminal[id]) continue;
    } else {
      const started = opts?.startedAt?.[id];
      if (!(opts?.firstBaselineAt != null && started != null && started >= opts.firstBaselineAt)) continue;
    }
    const label = KIND_LABEL[next.kindOf[id]] ?? "Report";
    out.push({
      key: `report-${id}-${status}`,
      title: status === "done" ? `${label} ready` : `${label} failed`,
      message: status === "done" ? `Your ${label.toLowerCase()} report is ready.` : `Your ${label.toLowerCase()} report failed.`,
    });
  }
  return out;
}
