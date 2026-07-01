// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/dream/harvest.ts
//
// Pure mapping from the analyze payload's DistilledSkill[]/Reflection[] into
// DreamQueueEntry[] for the dream queue. REM/insights harvesting is deferred
// (see plan note) — every entry produced here is phase:"DEEP".
import { createHash } from "node:crypto";
import type { DistilledSkill, DistilledLesson, Reflection, Provenance } from "@agentgem/insight";
import type { DreamQueueEntry } from "./types.js";

export function provenanceHash(p: Provenance): string {
  const sig = (p.occurrences ?? []).map((o) => `${o.sessionId}#${o.messageIndices.join(",")}`).sort().join("|");
  return createHash("sha1").update(sig).digest("hex").slice(0, 8);
}
function kebab(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
export function slugFromReflection(r: Reflection): string {
  const words = kebab(r.detail).split("-").filter(Boolean).slice(0, 3).join("-");
  return `${r.kind}-${words}`.slice(0, 45);
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
    const name = slugFromReflection(r);
    const h = provenanceHash(r.provenance);
    out.push({
      key: `lesson:${root}:${name}:${h}`, kind: "lesson", root, name,
      summary: r.detail, importance: r.importance, phase: "DEEP", draft: r,
      status: "queued", firstSeenMs: nowMs,
    });
  }
  return out;
}
// Total over any Reflection — callers pass `entry.draft as Reflection, entry.root` at the
// one kind-guarded site (Task 5), so this never receives a skill draft and never throws.
export function reflectionToLesson(r: Reflection, root: string): DistilledLesson {
  const sessions = new Set((r.provenance.occurrences ?? []).map((o) => o.sessionId)).size;
  return {
    name: slugFromReflection(r), body: r.detail, importance: r.importance, status: "draft",
    evidence: { sessions, root, provenance: r.provenance },
  };
}
