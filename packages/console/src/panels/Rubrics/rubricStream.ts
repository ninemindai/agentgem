// Rubric evaluation stream (named events start/delta/done/failed, modelled as one
// discriminated union). Consumed via @agentback/client's typed `route.stream()`
// over the server's `streamOf:` route — each event validated against the same
// schema shape the server yields (mirrored here because the console can't import
// root `src/`; api/routes.ts mirrors server schemas too).
import { z } from "zod";
import { defineRoute, type Client } from "@agentback/client";

export type VerdictValueView = "accepted" | "wrong" | "wontfix";
export interface FactorCalibrationView { reviewed: number; accepted: number; wrong: number; wontfix: number }
export interface VerdictView {
  sessionId: string; factorId: string; rubricId: string;
  verdict: VerdictValueView; note?: string; atMs: number;
}

export interface RubricFactorView {
  id: string;
  title: string;
  advice: string;
  severity: "info" | "warn";
  count: number;
  sessions: number;
  // Mirrors DetectorSummary. LLM criteria only — absent on cheap detectors and on
  // aggregate criteria, which have no per-session applicability. When present,
  // applicableSessions: 0 means the check was never exercised, NOT that it passed.
  applicableSessions?: number;
  judgedSessions?: number;
  // All-time human calibration. Absent when the factor has no verdicts, or the
  // store could not be read — never present with zeroes.
  calibration?: FactorCalibrationView;
}
export interface HygieneVerdictView { score: number; verdict: "bounded" | "mixed" | "bloated" }

export interface RubricReportView {
  rubricId: string;
  target: string;
  scope: string;
  factors: RubricFactorView[];
  sessionsScanned: number;
  clean: boolean;
  degraded: boolean;
  skippedFactors: { factor: string; reason: string }[];
  hygiene?: HygieneVerdictView;
  perSession?: {
    sessionId: string; transcript: string; factors: RubricFactorView[]; hygiene?: HygieneVerdictView;
    verdicts?: Record<string, VerdictView>;
  }[];
  perSessionTruncated?: boolean;
  // How much of the eligible universe the LLM criteria saw. Absent when the rubric
  // has no criteria (cheap factors always run over every session).
  judgeCoverage?: { eligible: number; judged: number; sampled: boolean; truncated: number };
  // Store unreadable. Distinct from "no verdicts yet" — the UI must say which.
  calibrationUnavailable?: boolean;
}

// Panel-facing union: `report` typed as the view the panel renders. The wire
// schema below keeps it opaque (z.unknown()); the bridge casts once.
export type RubricEvent =
  | { type: "start"; rubric: string; title: string; target: string; scope: string }
  | { type: "delta"; text: string }
  | { type: "done"; report: RubricReportView; cached: boolean; updatedAt: number | null }
  | { type: "failed"; message: string };

export interface RubricScopeParams {
  rubric: string;
  scope: "all" | "project" | "session";
  root?: string;
  sessionId?: string;
}

const RubricWireEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), rubric: z.string(), title: z.string(), target: z.string(), scope: z.string() }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("done"), report: z.unknown(), cached: z.boolean(), updatedAt: z.number().nullable() }),
  z.object({ type: z.literal("failed"), message: z.string() }),
]);

const rubricStreamRoute = defineRoute("GET", "/api/rubric/stream", {
  query: z.object({
    rubric: z.string(),
    scope: z.enum(["session", "project", "all"]).optional(),
    root: z.string().optional(),
    sessionId: z.string().optional(),
    refresh: z.string().optional(),
  }),
  streamOf: RubricWireEvent,
});

/**
 * Open the rubric-evaluation stream. Same `(onEvent) => cleanup` contract the
 * panel already uses, but typed end to end and validated per event. Returns a
 * function that aborts the stream (also stops the server generator via res.close).
 */
// ── Report render stream (GET /api/rubric/report) ───────────────────────────
// Turns a (cached) rubric evaluation into a self-contained HTML report via the
// server's plan-mode agent. Same addressing as the evaluation stream, no refresh.
export type RubricReportRenderEvent =
  | { type: "start"; rubric: string; title: string; scope: string }
  | { type: "delta"; text: string }
  | { type: "done"; html: string; truncated: boolean }
  | { type: "failed"; message: string };

const ReportWireEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), rubric: z.string(), title: z.string(), scope: z.string() }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("done"), html: z.string(), truncated: z.boolean() }),
  z.object({ type: z.literal("failed"), message: z.string() }),
]);

const rubricReportRoute = defineRoute("GET", "/api/rubric/report", {
  query: z.object({
    rubric: z.string(),
    scope: z.enum(["session", "project", "all"]).optional(),
    root: z.string().optional(),
    sessionId: z.string().optional(),
  }),
  streamOf: ReportWireEvent,
});

/** Open the report-render stream. Same `(onEvent) => cleanup` contract as
 *  openRubricStream. */
export function openRubricReportStream(
  client: Client,
  params: RubricScopeParams,
  onEvent: (e: RubricReportRenderEvent) => void,
): () => void {
  const ctrl = new AbortController();
  const query: { rubric: string; scope: RubricScopeParams["scope"]; root?: string; sessionId?: string } = {
    rubric: params.rubric,
    scope: params.scope,
  };
  if (params.root) query.root = params.root;
  if (params.sessionId) query.sessionId = params.sessionId;
  void (async () => {
    try {
      for await (const e of rubricReportRoute.stream(client, { query }, { signal: ctrl.signal })) onEvent(e);
    } catch {
      if (!ctrl.signal.aborted) onEvent({ type: "failed", message: "stream connection error" });
    }
  })();
  return () => ctrl.abort();
}

export function openRubricStream(
  client: Client,
  params: RubricScopeParams,
  onEvent: (e: RubricEvent) => void,
  fresh = false,
): () => void {
  const ctrl = new AbortController();
  const query: { rubric: string; scope: RubricScopeParams["scope"]; root?: string; sessionId?: string; refresh?: string } = {
    rubric: params.rubric,
    scope: params.scope,
  };
  if (params.root) query.root = params.root;
  if (params.sessionId) query.sessionId = params.sessionId;
  if (fresh) query.refresh = "true";
  void (async () => {
    try {
      for await (const e of rubricStreamRoute.stream(client, { query }, { signal: ctrl.signal })) {
        if (e.type === "done") onEvent({ ...e, report: e.report as RubricReportView });
        else onEvent(e);
      }
    } catch {
      if (!ctrl.signal.aborted) onEvent({ type: "failed", message: "stream connection error" });
    }
  })();
  return () => ctrl.abort();
}

const rubricVerdictRoute = defineRoute("POST", "/api/rubric/verdict", {
  body: z.object({
    sessionId: z.string(),
    factorId: z.string(),
    rubricId: z.string(),
    verdict: z.enum(["accepted", "wrong", "wontfix"]),
    // Mirror the server's cap. Without it a 501-character note round-trips to a 422
    // AFTER the person typed it; the input also carries maxLength={500}.
    note: z.string().max(500).optional(),
  }),
  response: z.object({
    ok: z.literal(true),
    atMs: z.number(),
    calibration: z.object({
      reviewed: z.number(), accepted: z.number(), wrong: z.number(), wontfix: z.number(),
    }),
  }),
});

/** Record one verdict. Rejects on a non-2xx so the caller can show the row unsaved. */
export function postRubricVerdict(
  client: Client,
  body: { sessionId: string; factorId: string; rubricId: string; verdict: VerdictValueView; note?: string },
): Promise<{ ok: true; atMs: number; calibration: FactorCalibrationView }> {
  return rubricVerdictRoute.call(client, { body });
}

/**
 * The calibration sentence. The denominator is REVIEWED calls, never total fires:
 * an untriaged fire is an unanswered question, and folding it in as an implicit
 * pass is the same unfalsifiable silence the judge's roster contract exists to
 * close. Callers must not render this for a factor with no calibration.
 */
export function calibrationLine(c: FactorCalibrationView): string {
  const head = c.wrong >= c.accepted
    ? `called wrong in ${c.wrong} of ${c.reviewed} reviewed calls`
    : `accepted in ${c.accepted} of ${c.reviewed} reviewed calls`;
  return c.wontfix > 0 ? `${head} · ${c.wontfix} won't fix` : head;
}
