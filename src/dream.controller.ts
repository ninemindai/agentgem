// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/dream.controller.ts
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { writeDistilledDraft, writeDistilledLesson } from "@agentgem/capture";
import type { DistilledSkill, Reflection } from "@agentgem/insight";
import { agentgemHome, InvalidInputError } from "@agentgem/model";
import { getWarmStatus, runWarmPass } from "./warm/orchestrator.js";
import { reflectionToLesson } from "@agentgem/insight";
import { readQueue, setStatus, promotedCount, readDiary } from "./dream/store.js";
import { dreamEnabled, setDreamEnabled } from "./dream/config.js";

// Path-safety guard for any name that becomes a filesystem path segment (skill dir /
// lesson file). Mirrors the per-write re-validation in gem.controller.ts.
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  kind: z.enum(["skill", "lesson", "opportunity"]),
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
  enqueued: z.object({ skills: z.number(), lessons: z.number(), opportunities: z.number().optional() }),
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
    // Opportunities (REM publish-candidates) write no file — accepting is an
    // acknowledgement; the panel routes to the Curate/publish flow for the session.
    if (entry.kind === "opportunity") {
      setStatus(entry.key, "accepted", Date.now(), this.base);
      return { ok: true, path: "" };
    }
    // Defense-in-depth: validate the EXACT name used to compose the on-disk path — not
    // entry.name in general. writeDistilledDraft builds the skill dir from draft.name, so a
    // corrupted queue.json could pair a safe entry.name with an unsafe draft.name.
    let path: string;
    if (entry.kind === "skill") {
      const skill = entry.draft as DistilledSkill;
      if (!NAME_RE.test(skill.name)) throw new InvalidInputError(`Unsafe skill name '${skill.name}'.`);
      path = writeDistilledDraft(skill, this.base);
    } else {
      const lesson = reflectionToLesson(entry.draft as Reflection, entry.root);
      if (!lesson) throw new InvalidInputError(`Draft '${entry.key}' is not a shareable lesson.`); // unresolved-task
      if (!NAME_RE.test(entry.name)) throw new InvalidInputError(`Unsafe lesson name '${entry.name}'.`);
      // entry.name is the queue's canonical (hash-suffixed, unique) identity → the file name.
      path = writeDistilledLesson({ ...lesson, name: entry.name }, this.base);
    }
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
