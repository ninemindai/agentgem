// Rubric evaluation stream (named SSE events: start/done/failed), consumed via
// native EventSource — same shape as insightsStream.ts.

export interface RubricFactorView {
  id: string;
  title: string;
  advice: string;
  severity: "info" | "warn";
  count: number;
  sessions: number;
}
export interface RubricReportView {
  rubricId: string;
  target: string;
  scope: string;
  factors: RubricFactorView[];
  sessionsScanned: number;
  clean: boolean;
  degraded: boolean;
  skippedFactors: { factor: string; reason: string }[];
  perSession?: { sessionId: string; transcript: string; factors: RubricFactorView[] }[];
  perSessionTruncated?: boolean;
}

export type RubricEvent =
  | { type: "start"; rubric: string; title: string; target: string; scope: string }
  | { type: "done"; report: RubricReportView; cached: boolean; updatedAt: number | null }
  | { type: "failed"; message: string };

export interface RubricScopeParams {
  rubric: string;
  scope: "all" | "project" | "session";
  root?: string;
  sessionId?: string;
}

export function openRubricStream(
  apiBase: string,
  params: RubricScopeParams,
  onEvent: (e: RubricEvent) => void,
  fresh = false,
): () => void {
  const qs = new URLSearchParams({ rubric: params.rubric, scope: params.scope });
  if (params.root) qs.set("root", params.root);
  if (params.sessionId) qs.set("sessionId", params.sessionId);
  if (fresh) qs.set("refresh", "true");
  const es = new EventSource(`${apiBase}/api/rubric/stream?${qs.toString()}`);
  const data = (m: Event) => JSON.parse((m as MessageEvent).data);

  es.addEventListener("start", (m) => {
    const d = data(m);
    onEvent({ type: "start", rubric: d.rubric, title: d.title, target: d.target, scope: d.scope });
  });
  es.addEventListener("done", (m) => {
    const d = data(m);
    onEvent({ type: "done", report: d.report, cached: !!d.cached, updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : null });
    es.close();
  });
  es.addEventListener("failed", (m) => { onEvent({ type: "failed", message: data(m).message }); es.close(); });
  es.addEventListener("error", () => onEvent({ type: "failed", message: "stream connection error" }));

  return () => es.close();
}
