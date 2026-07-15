// Rubric evaluation stream (named events start/delta/done/failed, modelled as one
// discriminated union). Consumed via @agentback/client's typed `route.stream()`
// over the server's `streamOf:` route — each event validated against the same
// schema shape the server yields (mirrored here because the console can't import
// root `src/`; api/routes.ts mirrors server schemas too).
import { z } from "zod";
import { defineRoute, type Client } from "@agentback/client";

export interface RubricFactorView {
  id: string;
  title: string;
  advice: string;
  severity: "info" | "warn";
  count: number;
  sessions: number;
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
  perSession?: { sessionId: string; transcript: string; factors: RubricFactorView[]; hygiene?: HygieneVerdictView }[];
  perSessionTruncated?: boolean;
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
