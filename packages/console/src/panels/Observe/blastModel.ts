// packages/console/src/panels/Observe/blastModel.ts
//
// Pure view-model for the session blast-radius map: fold the server's ordered
// touch events into deterministic target groups (same session ⇒ same map, so
// replays are comparable), a bucketed cool/warm playback histogram, and jump
// lists for the keyboard stepper. No React, no fetch — mirrored by tests.
import type { BlastEvent, BlastReport } from "../../api/routes.js";

export type TargetKind = "file" | "skill" | "agent" | "mcp" | "exec";
export interface Visit { seq: number; tsMs: number | null; tool: string; action: BlastEvent["action"]; error?: boolean; sidechain?: boolean }
export interface BlastTarget {
  key: string;                // `${kind}|${zone ?? ""}|${full}` — stable pin identity
  kind: TargetKind;
  zone?: NonNullable<BlastEvent["zone"]>;
  name: string;               // display: basename for files, raw name otherwise
  full: string;               // full target string (tooltip / inspector)
  visits: Visit[];
  edited: boolean;
  error: boolean;
  sidechainOnly: boolean;
}
export interface BlastGroup { label: string; targets: BlastTarget[] }
export interface Bucket { i: number; fromSeq: number; toSeq: number; observe: number; mutate: number; marks: number; errors: number }
export interface BlastModel {
  n: number;
  groups: BlastGroup[];
  buckets: Bucket[];
  axis: "time" | "index";
  edits: number[];            // seqs of edit events (E key)
  errors: number[];           // seqs of errored events (X key)
  summary: { files: number; edited: number; outside: number; skills: number; agents: number; mcp: number; errors: number };
}

const MAX_BUCKETS = 72;
const OBSERVE = new Set<BlastEvent["action"]>(["read", "search", "exec", "mcp", "other"]);
const MARK = new Set<BlastEvent["action"]>(["skill", "agent"]);

function kindOf(e: BlastEvent): TargetKind | null {
  if (e.action === "read" || e.action === "search" || e.action === "edit") return e.target ? "file" : null;
  if (e.action === "skill") return e.target ? "skill" : null;
  if (e.action === "agent") return e.target ? "agent" : null;
  if (e.action === "mcp") return e.target ? "mcp" : null;
  if (e.action === "exec") return e.target ? "exec" : null;
  return null;
}

/** Deepest touch a target has received up to (and including) `playhead` seq:
 *  0 = not yet, 1 = observed (read/search or non-file invocation), 2 = edited. */
export function depthAt(t: BlastTarget, playhead: number): 0 | 1 | 2 {
  let depth: 0 | 1 | 2 = 0;
  for (const v of t.visits) {
    if (v.seq > playhead) break;
    depth = v.action === "edit" ? 2 : depth || 1;
  }
  return depth;
}

/** Visits up to the playhead — the inspector count. */
export function visitsAt(t: BlastTarget, playhead: number): number {
  let n = 0;
  for (const v of t.visits) { if (v.seq > playhead) break; n++; }
  return n;
}

const ZONE_LABEL: Record<NonNullable<BlastEvent["zone"]>, string> = {
  project: "", home: "outside · home (~)", tmp: "outside · tmp", outside: "outside · other",
};

export function buildBlast(rep: BlastReport): BlastModel {
  const byKey = new Map<string, BlastTarget>();
  const edits: number[] = [];
  const errors: number[] = [];

  for (const e of rep.events) {
    if (e.action === "edit") edits.push(e.seq);
    if (e.error) errors.push(e.seq);
    const kind = kindOf(e);
    if (!kind || !e.target) continue;
    const zone = kind === "file" ? (e.zone ?? "project") : undefined;
    const key = `${kind}|${zone ?? ""}|${e.target}`;
    let t = byKey.get(key);
    if (!t) {
      t = {
        key, kind, ...(zone ? { zone } : {}),
        name: kind === "file" ? (e.target.split("/").pop() || e.target) : e.target,
        full: e.target, visits: [], edited: false, error: false, sidechainOnly: true,
      };
      byKey.set(key, t);
    }
    t.visits.push({ seq: e.seq, tsMs: e.tsMs, tool: e.tool, action: e.action, ...(e.error ? { error: true } : {}), ...(e.sidechain ? { sidechain: true } : {}) });
    if (e.action === "edit") t.edited = true;
    if (e.error) t.error = true;
    if (!e.sidechain) t.sidechainOnly = false;
  }

  // Deterministic grouping: project files by top-level dir, then the outside
  // zones, then skills / subagents / MCP servers / commands. Alpha inside each.
  const targets = [...byKey.values()].sort((a, b) => a.full.localeCompare(b.full));
  const groupMap = new Map<string, BlastTarget[]>();
  const push = (label: string, t: BlastTarget) => {
    const list = groupMap.get(label) ?? [];
    list.push(t);
    groupMap.set(label, list);
  };
  for (const t of targets) {
    if (t.kind === "file") {
      if (t.zone === "project") {
        const top = t.full.includes("/") ? t.full.slice(0, t.full.indexOf("/")) + "/" : "./";
        push(top, t);
      } else push(ZONE_LABEL[t.zone ?? "outside"], t);
    }
  }
  const fileGroups = [...groupMap.entries()]
    .sort(([a], [b]) => (a.startsWith("outside") === b.startsWith("outside") ? a.localeCompare(b) : a.startsWith("outside") ? 1 : -1))
    .map(([label, ts]) => ({ label, targets: ts }));
  const kindGroup = (kind: TargetKind, label: string): BlastGroup[] => {
    const ts = targets.filter((t) => t.kind === kind);
    return ts.length ? [{ label, targets: ts }] : [];
  };
  const groups: BlastGroup[] = [
    ...fileGroups,
    ...kindGroup("skill", "skills"),
    ...kindGroup("agent", "subagents"),
    ...kindGroup("mcp", "mcp servers"),
    ...kindGroup("exec", "commands"),
  ];

  // Buckets: by wall-clock when nearly all events carry timestamps (bursts show),
  // else uniformly by event index.
  const n = rep.events.length;
  const stamped = rep.events.filter((e) => e.tsMs !== null).length;
  const span = rep.meta.endMs - rep.meta.startMs;
  const axis: BlastModel["axis"] = n > 0 && stamped / n >= 0.9 && span > 0 ? "time" : "index";
  const B = Math.max(1, Math.min(MAX_BUCKETS, n));
  const buckets: Bucket[] = Array.from({ length: n ? B : 0 }, (_, i) => ({ i, fromSeq: -1, toSeq: -1, observe: 0, mutate: 0, marks: 0, errors: 0 }));
  let lastIdx = 0;
  for (const e of rep.events) {
    let idx: number;
    if (axis === "time" && e.tsMs !== null) idx = Math.min(B - 1, Math.max(0, Math.floor(((e.tsMs - rep.meta.startMs) / span) * B)));
    else if (axis === "time") idx = lastIdx;                    // unstamped rider joins the previous bucket
    else idx = Math.min(B - 1, Math.floor((e.seq / n) * B));
    lastIdx = idx;
    const b = buckets[idx];
    if (b.fromSeq === -1) b.fromSeq = e.seq;
    b.toSeq = e.seq;
    if (e.action === "edit") b.mutate++;
    else if (MARK.has(e.action)) b.marks++;
    else if (OBSERVE.has(e.action)) b.observe++;
    if (e.error) b.errors++;
  }
  // Empty buckets seek to the latest preceding event so a deck click always lands.
  let prev = -1;
  for (const b of buckets) {
    if (b.toSeq === -1) { b.fromSeq = prev; b.toSeq = prev; } else prev = b.toSeq;
  }

  const files = targets.filter((t) => t.kind === "file");
  return {
    n, groups, buckets, axis, edits, errors,
    summary: {
      files: files.length,
      edited: files.filter((t) => t.edited).length,
      outside: files.filter((t) => t.zone !== "project").length,
      skills: targets.filter((t) => t.kind === "skill").length,
      agents: targets.filter((t) => t.kind === "agent").length,
      mcp: targets.filter((t) => t.kind === "mcp").length,
      errors: errors.length,
    },
  };
}
