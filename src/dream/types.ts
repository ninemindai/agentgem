// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/dream/types.ts
import type { DistilledSkill, Reflection, PublishCandidate } from "@agentgem/insight";

// skill/lesson = DEEP drafts written to disk on accept; opportunity = a REM
// publish-candidate (a succeeded session worth publishing) — accepting it routes
// to the Curate/publish flow instead of writing a file.
export type DreamKind = "skill" | "lesson" | "opportunity";
export type DreamStatus = "queued" | "accepted" | "dismissed";

export interface DreamQueueEntry {
  /** Stable dedup key: skills/lessons `${kind}:${root}:${name}:${provenanceHash}`; opportunities `opportunity:${root}:${sessionId}`. */
  key: string;
  kind: DreamKind;
  root: string;
  name: string;
  summary: string;
  confidence?: "high" | "medium" | "low"; // skills
  importance?: "high" | "medium";         // lessons
  phase: "DEEP" | "REM";
  /** Full body for the Curate handoff (opaque to the queue). */
  draft: DistilledSkill | Reflection | PublishCandidate;
  status: DreamStatus;
  firstSeenMs: number;
  reviewedMs?: number;
}

export interface DreamDiaryEntry {
  atMs: number;
  passId: number; // per-root harvest timestamp (NOT a pass-wide id; the Warmable interface exposes no pass timestamp)
  rootsProcessed: string[];
  phasesLit: Array<"LIGHT" | "DEEP" | "REM">;
  enqueued: { skills: number; lessons: number; opportunities?: number };
  degraded: boolean;
}
