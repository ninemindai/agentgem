// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/dream.controller.ts
import { z } from "zod";
import { join } from "node:path";
import { api, get, post } from "@agentback/openapi";
import { writeDistilledDraft, writeDistilledLesson } from "@agentgem/capture";
import type { DistilledSkill, Reflection, GuardrailDraft } from "@agentgem/insight";
import { agentgemHome, InvalidInputError, resolveTarget, previewGuardrails, applyGuardrails } from "@agentgem/model";
import { getWarmStatus, runWarmPass } from "./warm/orchestrator.js";
import { reflectionToLesson } from "@agentgem/insight";
import { readQueue, setStatus, promotedCount, readDiary } from "./dream/store.js";
import { dreamEnabled, setDreamEnabled } from "./dream/config.js";
import { learnFromSession } from "./learnCore.js";
import { buildJourney } from "./journeyCore.js";

// Path-safety guard for any name that becomes a filesystem path segment (skill dir /
// lesson file). Mirrors the per-write re-validation in gem.controller.ts.
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// `key` alone drives status reads/dismiss/preview. The guardrail accept leg also
// carries the human-authored `directive`, the previewed `expectHash` (drift guard),
// and the resolved `target` — all optional so the other routes ignore them.
const KeyBody = z.object({
  key: z.string().min(1),
  expectHash: z.string().optional(),
  target: z.enum(["claude", "agents"]).optional(),
  directive: z.string().optional(),
});
const GuardrailPreviewSchema = z.object({
  current: z.string(),
  next: z.string(),
  hash: z.string(),
  file: z.string().nullable(),
  target: z.enum(["claude", "agents"]).nullable(),
  ambiguous: z.boolean(),
  malformed: z.boolean(),
  seed: z.string(),
});
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
  kind: z.enum(["skill", "lesson", "opportunity", "guardrail"]),
  root: z.string(),
  name: z.string(),
  summary: z.string(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  importance: z.enum(["high", "medium"]).optional(),
  phase: z.enum(["DEEP", "REM", "LEARN"]),
  status: z.enum(["queued", "accepted", "dismissed"]),
  firstSeenMs: z.number(),
  reviewedMs: z.number().optional(),
  target: z.enum(["claude", "agents"]).optional(),
  draft: z.unknown(), // opaque body (DistilledSkill | Reflection | GuardrailDraft) — not re-validated here
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
  enqueued: z.object({ skills: z.number(), lessons: z.number(), opportunities: z.number().optional(), guardrails: z.number().optional() }),
  degraded: z.boolean(),
});
const DiarySchema = z.object({ entries: z.array(DiaryEntrySchema) });
const JourneyQuerySchema = z.object({
  kind: z.enum(["skill", "lesson", "opportunity", "guardrail", "pass", "verified"]).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});
const JourneyEventSchema = z.object({
  ts: z.number(),
  kind: z.enum(["skill", "lesson", "opportunity", "guardrail", "pass", "verified"]),
  title: z.string(),
  detail: z.string().optional(),
  status: z.enum(["queued", "accepted", "dismissed"]).optional(),
  phase: z.enum(["DEEP", "REM", "LEARN"]).optional(),
  key: z.string().optional(),
  firstSeenMs: z.number().optional(),
  root: z.string().optional(),
  agent: z.string().optional(),
  passed: z.boolean().optional(),
});
const JourneySchema = z.object({ events: z.array(JourneyEventSchema), truncated: z.boolean() });
const LearnBody = z.object({
  root: z.string().min(1),
  dir: z.string().optional(),      // claude-home override (tests / non-default homes)
  session: z.string().optional(),  // transcript basename (".jsonl" optional); default: newest
});
const LearnResultSchema = z.object({
  session: z.string(),
  enqueued: z.number(),
  entries: z.array(z.object({ kind: z.enum(["skill", "lesson", "guardrail"]), name: z.string() })),
  skills: z.number(),
  lessons: z.number(),
  guardrails: z.number(),
  degraded: z.boolean(),
});

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

  // The unified learning timeline: queue items (all statuses), dream passes, and
  // verification-ledger records, newest first. A read-side lens — mutations stay
  // on the queue endpoints above.
  @get("/journey", { query: JourneyQuerySchema, response: JourneySchema })
  async journey(input: { query: z.infer<typeof JourneyQuerySchema> }): Promise<z.infer<typeof JourneySchema>> {
    return buildJourney({ base: this.base, kind: input.query.kind, limit: input.query.limit });
  }

  // Pure preview of the managed-region write for a guardrail entry: resolve the
  // target file, render current→next, and return the drift-guard hash. The `seed`
  // (derived from the detector detail) prefills the panel's editable directive box.
  @post("/dream/guardrail/preview", { body: KeyBody, response: GuardrailPreviewSchema })
  async previewGuardrail(input: { body: z.infer<typeof KeyBody> }): Promise<z.infer<typeof GuardrailPreviewSchema>> {
    const entry = readQueue(this.base).find((e) => e.key === input.body.key);
    if (!entry || entry.kind !== "guardrail") throw new InvalidInputError(`No guardrail '${input.body.key}'.`);
    const resolved = resolveTarget(entry.root);
    // No CLAUDE.md/AGENTS.md yet → default to creating CLAUDE.md in the project root.
    const file = resolved.file ?? join(entry.root, "CLAUDE.md");
    const target = resolved.target ?? "claude";
    const seed = `- ${(entry.draft as GuardrailDraft).detail}`;
    const { current, next, hash, malformed } = previewGuardrails(file, [seed]);
    return { current, next, hash, file, target, ambiguous: resolved.ambiguous, malformed: !!malformed, seed };
  }

  @post("/dream/queue/accept", { body: KeyBody, response: OkPathSchema })
  async accept(input: { body: z.infer<typeof KeyBody> }): Promise<z.infer<typeof OkPathSchema>> {
    const entry = readQueue(this.base).find((e) => e.key === input.body.key);
    if (!entry) throw new InvalidInputError(`No queued draft '${input.body.key}'.`);
    // A GuardrailDraft is not a Reflection — it upserts a managed block into
    // CLAUDE.md/AGENTS.md rather than writing a distilled file. The human authored
    // `directive` from the panel is what lands (the seed is only a starting point);
    // the write is hash-guarded against on-disk drift since preview.
    if (entry.kind === "guardrail") {
      const { expectHash, target, directive } = input.body;
      const label = target === "agents" ? "AGENTS.md" : "CLAUDE.md";
      const file = join(entry.root, label);
      const block = directive ?? `- ${(entry.draft as GuardrailDraft).detail}`;
      const res = applyGuardrails(file, [block], expectHash ?? "");
      if (!res.ok) {
        if (res.reason === "corrupt") {
          throw new InvalidInputError(`The managed block in ${label} is malformed — fix it by hand, then re-apply.`);
        }
        throw new InvalidInputError(`${label} changed since preview — re-open the diff and apply again.`);
      }
      setStatus(entry.key, "accepted", Date.now(), this.base);
      return { ok: true, path: res.path };
    }
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

  // Intent-driven distillation ("/learn on a session"): run the extractor over one
  // transcript now and land candidates in this review queue as phase:"LEARN". The
  // second entry point into the same queue — accept/dismiss flow is unchanged.
  @post("/dream/learn", { body: LearnBody, response: LearnResultSchema })
  async learn(input: { body: z.infer<typeof LearnBody> }): Promise<z.infer<typeof LearnResultSchema>> {
    return learnFromSession({ ...input.body, base: this.base });
  }
}
