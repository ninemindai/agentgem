// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/dream/harvest.ts
//
// Pure mapping from the warm caches into DreamQueueEntry[]: the analyze payload's
// DistilledSkill[]/Reflection[] become phase:"DEEP" skill/lesson drafts, and the
// insights payload's PublishCandidate[] become phase:"REM" "opportunity" entries.
// Lesson slugging + the "unresolved-task is a personal gap, not a shareable lesson"
// rule reuse the canonical @agentgem/insight helpers so this never diverges from the
// distillation pipeline.
import { createHash } from "node:crypto";
import { reflectionToLesson } from "@agentgem/insight";
import type { DistilledSkill, Reflection, Provenance, PublishCandidate } from "@agentgem/insight";
import type { DreamQueueEntry } from "./types.js";

export function provenanceHash(p: Provenance): string {
  const sig = (p.occurrences ?? []).map((o) => `${o.sessionId}#${o.messageIndices.join(",")}`).sort().join("|");
  return createHash("sha1").update(sig).digest("hex").slice(0, 8);
}
export function harvestEntries(root: string, distilled: DistilledSkill[], reflections: Reflection[], nowMs: number): DreamQueueEntry[] {
  const out: DreamQueueEntry[] = [];
  for (const s of distilled) {
    const h = provenanceHash(s.evidence.provenance);
    out.push({
      key: `skill:${root}:${s.name}:${h}`, kind: "skill", root, name: s.name,
      summary: s.description, confidence: s.confidence, phase: "DEEP", draft: s,
      status: "queued", firstSeenMs: nowMs,
    });
  }
  for (const r of reflections) {
    const lesson = reflectionToLesson(r, root); // canonical: null for unresolved-task (not shareable)
    if (!lesson) continue;
    const h = provenanceHash(r.provenance);
    // Suffix the provenance hash so two reflections that slug identically still get distinct
    // filenames on accept — writeDistilledLesson overwrites `lessons/<name>.md` with no guard.
    const name = `${lesson.name}-${h}`;
    out.push({
      key: `lesson:${root}:${name}`, kind: "lesson", root, name,
      summary: r.detail, importance: r.importance, phase: "DEEP", draft: r,
      status: "queued", firstSeenMs: nowMs,
    });
  }
  return out;
}
// REM: succeeded sessions worth publishing. sessionId is the stable identity, so the
// dedup key uses it directly (no provenance hash). Accepting an opportunity routes to the
// Curate/publish flow (no distilled file is written), so `name` is never a path segment.
export function opportunityEntries(root: string, candidates: PublishCandidate[], nowMs: number): DreamQueueEntry[] {
  return candidates.map((c) => ({
    key: `opportunity:${root}:${c.sessionId}`, kind: "opportunity" as const, root, name: c.sessionId,
    summary: c.goal, phase: "REM" as const, draft: c, status: "queued" as const, firstSeenMs: nowMs,
  }));
}
