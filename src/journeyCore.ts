// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/journeyCore.ts
//
// The /journey timeline: a pure read-side merge of everything AgentGem learned —
// dream-queue items (ALL statuses, so accepted/dismissed history is visible),
// dream passes, and the verification-evidence ledger. A lens, not a store: this
// module writes nothing; the only mutations stay on the existing queue endpoints.
import { readVerifications } from "@agentgem/run";
import { readQueue, readDiary } from "./dream/store.js";

export interface JourneyEvent {
  ts: number;                                   // epoch ms, sort key (newest first)
  kind: "skill" | "lesson" | "opportunity" | "pass" | "verified";
  title: string;
  detail?: string;
  status?: "queued" | "accepted" | "dismissed"; // queue-backed events only
  phase?: "DEEP" | "REM" | "LEARN";             // queue-backed events only
  key?: string;                                 // queue key — with status "queued", enables actions
  firstSeenMs?: number;                         // queue-backed: when it originally queued
  root?: string;
  agent?: string;                               // verified events
  passed?: boolean;                             // verified events
}

export interface JourneyResult { events: JourneyEvent[]; truncated: boolean }

export function buildJourney(opts: {
  base?: string;
  kind?: JourneyEvent["kind"];
  limit?: number;
  readLedger?: typeof readVerifications;
} = {}): JourneyResult {
  const limit = opts.limit ?? 100;
  const events: JourneyEvent[] = [];

  for (const e of readQueue(opts.base)) {
    events.push({
      ts: e.reviewedMs ?? e.firstSeenMs,
      kind: e.kind, title: e.name, detail: e.summary,
      status: e.status, phase: e.phase, key: e.key,
      firstSeenMs: e.firstSeenMs, root: e.root,
    });
  }
  for (const d of readDiary(opts.base)) {
    events.push({
      ts: d.atMs, kind: "pass", title: `dream pass #${d.passId}`,
      detail: `${d.phasesLit.join("+") || "no phases"} · +${d.enqueued.skills} skills · +${d.enqueued.lessons} lessons · +${d.enqueued.opportunities ?? 0} opportunities${d.degraded ? " · degraded" : ""}`,
      root: d.rootsProcessed.length === 1 ? d.rootsProcessed[0] : undefined,
    });
  }
  for (const r of (opts.readLedger ?? readVerifications)(opts.base)) {
    const ts = Date.parse(r.ts);
    if (Number.isNaN(ts)) continue;             // torn record — skip, never throw
    const firstFail = r.verification.checks.find((c) => !c.passed);
    events.push({
      ts, kind: "verified",
      title: r.gemName ?? r.gemDigest ?? "gem",
      detail: firstFail ? `${firstFail.name}: ${firstFail.detail}` : "all checks passed",
      agent: r.agent, passed: r.verification.passed,
    });
  }

  const filtered = (opts.kind ? events.filter((e) => e.kind === opts.kind) : events)
    .sort((a, b) => b.ts - a.ts);
  return { events: filtered.slice(0, limit), truncated: filtered.length > limit };
}
