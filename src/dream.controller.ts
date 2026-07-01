// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/dream.controller.ts
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { writeDistilledDraft, writeDistilledLesson } from "@agentgem/capture";
import type { DistilledSkill, Reflection } from "@agentgem/insight";
import { agentgemHome, InvalidInputError } from "@agentgem/model";
import { getWarmStatus, runWarmPass } from "./warm/orchestrator.js";
import { readQueue, setStatus, promotedCount, readDiary } from "./dream/store.js";
import { dreamEnabled, setDreamEnabled } from "./dream/config.js";
import { reflectionToLesson } from "./dream/harvest.js";

const KeyBody = z.object({ key: z.string().min(1) });
const EnableBody = z.object({ enabled: z.boolean() });
const StatusSchema = z.object({
  enabled: z.boolean(),
  phasesLit: z.array(z.enum(["LIGHT", "DEEP", "REM"])),
  promoted: z.number(),
  queued: z.number(),
  lastPassAtMs: z.number().nullable(),
});
const QueueItemSchema = z.object({
  key: z.string(),
  kind: z.enum(["skill", "lesson"]),
  root: z.string(),
  name: z.string(),
  summary: z.string(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  importance: z.enum(["high", "medium"]).optional(),
  phase: z.enum(["DEEP", "REM"]),
  status: z.enum(["queued", "accepted", "dismissed"]),
  firstSeenMs: z.number(),
  reviewedMs: z.number().optional(),
  draft: z.unknown(), // opaque body (DistilledSkill | Reflection) — not re-validated here
});
const QueueSchema = z.object({ items: z.array(QueueItemSchema) });
const OkPathSchema = z.object({ ok: z.boolean(), path: z.string() });
const OkSchema = z.object({ ok: z.boolean() });
const StartedSchema = z.object({ started: z.boolean() });
const DiaryEntrySchema = z.object({
  atMs: z.number(),
  passId: z.number(),
  rootsProcessed: z.array(z.string()),
  phasesLit: z.array(z.enum(["LIGHT", "DEEP", "REM"])),
  enqueued: z.object({ skills: z.number(), lessons: z.number() }),
  degraded: z.boolean(),
});
const DiarySchema = z.object({ entries: z.array(DiaryEntrySchema) });

const PHASE_OF: Record<string, "LIGHT" | "DEEP" | "REM"> = {
  usage: "LIGHT", scorecard: "LIGHT", analyze: "DEEP", insights: "REM",
};

@api({ basePath: "/api" })
export class DreamController {
  private base = agentgemHome();

  @get("/dream/status", { response: StatusSchema })
  async status(): Promise<z.infer<typeof StatusSchema>> {
    const last = getWarmStatus().last;
    const lit = new Set<"LIGHT" | "DEEP" | "REM">();
    for (const o of last?.outcomes ?? []) {
      if ((o.status === "warmed" || o.status === "hit") && PHASE_OF[o.id]) lit.add(PHASE_OF[o.id]);
    }
    return {
      enabled: dreamEnabled(this.base),
      phasesLit: [...lit],
      promoted: promotedCount(this.base),
      queued: readQueue(this.base).filter((e) => e.status === "queued").length,
      lastPassAtMs: last?.finishedAt ?? null,
    };
  }

  @get("/dream/queue", { response: QueueSchema })
  async queue(): Promise<z.infer<typeof QueueSchema>> {
    return { items: readQueue(this.base).filter((e) => e.status === "queued") };
  }

  @get("/dream/diary", { response: DiarySchema })
  async diary(): Promise<z.infer<typeof DiarySchema>> {
    return { entries: readDiary(this.base) }; // newest-first, bounded by the store
  }

  @post("/dream/queue/accept", { body: KeyBody, response: OkPathSchema })
  async accept(input: { body: z.infer<typeof KeyBody> }): Promise<z.infer<typeof OkPathSchema>> {
    const entry = readQueue(this.base).find((e) => e.key === input.body.key);
    if (!entry) throw new InvalidInputError(`No queued draft '${input.body.key}'.`);
    // Defense-in-depth: entry.name becomes a filesystem path segment in both writers
    // (draftStage.ts), so re-validate the kebab shape here — mirrors gem.controller.ts's
    // sibling accept endpoints, which re-check the name at every path-composing write.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) throw new InvalidInputError(`Unsafe draft name '${entry.name}'.`);
    // reflectionToLesson derives its own name via slugFromReflection(r), which in
    // production always matches entry.name (harvestEntries sets both the same way).
    // Override with entry.name anyway so the file is named after the queue's
    // canonical (already-deduped) identity rather than a name recomputed from the draft.
    const path = entry.kind === "skill"
      ? writeDistilledDraft(entry.draft as DistilledSkill, this.base)
      : writeDistilledLesson({ ...reflectionToLesson(entry.draft as Reflection, entry.root), name: entry.name }, this.base);
    setStatus(entry.key, "accepted", Date.now(), this.base);
    return { ok: true, path };
  }

  @post("/dream/queue/dismiss", { body: KeyBody, response: OkSchema })
  async dismiss(input: { body: z.infer<typeof KeyBody> }): Promise<z.infer<typeof OkSchema>> {
    if (!setStatus(input.body.key, "dismissed", Date.now(), this.base)) {
      throw new InvalidInputError(`No draft '${input.body.key}'.`);
    }
    return { ok: true };
  }

  @post("/dream/enable", { body: EnableBody, response: EnableBody })
  async enable(input: { body: z.infer<typeof EnableBody> }): Promise<z.infer<typeof EnableBody>> {
    setDreamEnabled(input.body.enabled, this.base);
    return { enabled: input.body.enabled };
  }

  @post("/dream/run", { response: StartedSchema })
  async run(): Promise<z.infer<typeof StartedSchema>> {
    void runWarmPass({ force: true }).catch(() => {}); // best-effort; a pre-loop throw must not become an unhandled rejection
    return { started: true };
  }
}
