// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/dream/types.ts
import type { DistilledSkill, Reflection } from "@agentgem/insight";

export type DreamKind = "skill" | "lesson";
export type DreamStatus = "queued" | "accepted" | "dismissed";

export interface DreamQueueEntry {
  /** Stable dedup key: `${kind}:${root}:${name}:${provenanceHash}`. */
  key: string;
  kind: DreamKind;
  root: string;
  name: string;
  summary: string;
  confidence?: "high" | "medium" | "low"; // skills
  importance?: "high" | "medium";         // lessons
  phase: "DEEP" | "REM";
  /** Full body for the Curate handoff. */
  draft: DistilledSkill | Reflection;
  status: DreamStatus;
  firstSeenMs: number;
  reviewedMs?: number;
}

export interface DreamDiaryEntry {
  atMs: number;
  passId: number; // WarmPassResult.finishedAt
  rootsProcessed: string[];
  phasesLit: Array<"LIGHT" | "DEEP" | "REM">;
  enqueued: { skills: number; lessons: number };
  degraded: boolean;
}
