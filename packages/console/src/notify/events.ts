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

export interface AttentionSessionSnap {
  id: string;
  file: string;
  project: string | null;
  state: "pending" | "busy" | "idle";
  pendingKey: number | null;
  pendingToolName: string | null;
}
export interface AttentionSnapshot { sessions: AttentionSessionSnap[] }

// One NotifyEvent per ENROLLED session that transitioned into pending (or into a
// NEW stall — the pendingKey changed). First snapshot is a silent baseline, like
// detectWarm. Copy hedges "(or a long tool run)": the transcript can't distinguish
// a permission prompt from a slow tool.
export function detectAttention(
  prev: AttentionSnapshot | null,
  next: AttentionSnapshot,
  enrolled: Set<string>,
): NotifyEvent[] {
  if (!prev) return [];
  const prevKey = new Map(prev.sessions.map((s) => [s.id, s.state === "pending" ? s.pendingKey : null]));
  const out: NotifyEvent[] = [];
  for (const s of next.sessions) {
    if (s.state !== "pending" || s.pendingKey === null || !enrolled.has(s.file)) continue;
    if (prevKey.get(s.id) === s.pendingKey) continue;
    const who = s.project ?? s.id.slice(0, 8);
    out.push({
      key: `attention-${s.id}-${s.pendingKey}`,
      title: "Session needs your input",
      message: `${who} — waiting on approval for ${s.pendingToolName ?? "a tool"} (or a long tool run).`,
    });
  }
  return out;
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

// Baseline-merge for the provider: keep vanished PENDING sessions in the stored
// snapshot. A transient read failure on the server drops a session from one
// attention response; without carrying it forward, the same stall would re-fire
// detectAttention when the session reappears with an unchanged pendingKey.
// Idle/busy sessions are not carried — their absence has nothing to suppress.
export function carryVanishedPending(prev: AttentionSnapshot | null, next: AttentionSnapshot): AttentionSnapshot {
  if (!prev) return next;
  const present = new Set(next.sessions.map((s) => s.id));
  const carried = prev.sessions.filter((s) => s.state === "pending" && !present.has(s.id));
  return carried.length === 0 ? next : { sessions: [...next.sessions, ...carried] };
}
