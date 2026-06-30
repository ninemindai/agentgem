// Personal session-insights stream (named SSE events: phase/delta/done/failed),
// consumed via native EventSource — same shape as analyzeStream.ts.

export interface InsightsReportView {
  totals: { sessions: number; mostly: number; partially: number; not: number };
  outcomes_summary: string;
  narrative: string;
  by_model: { model: string; mostly: number; partially: number; not: number; total: number }[];
  friction: { sessionId: string; detail: string }[];
  publish_candidates: { sessionId: string; goal: string; why: string }[];
}

export type InsightsEvent =
  | { type: "phase"; phase: string; transcripts?: number; sessions?: number }
  | { type: "delta"; text: string }
  | { type: "done"; report: InsightsReportView; degraded: boolean; scanned?: number }
  | { type: "failed"; message: string };

export function openInsightsStream(
  apiBase: string,
  root: string,
  onEvent: (e: InsightsEvent) => void,
  fresh = false,
): () => void {
  const params = new URLSearchParams({ root });
  if (fresh) params.set("fresh", "1");
  const es = new EventSource(`${apiBase}/api/insights/stream?${params.toString()}`);
  const data = (m: Event) => JSON.parse((m as MessageEvent).data);

  es.addEventListener("phase", (m) => {
    const d = data(m);
    onEvent({ type: "phase", phase: d.phase, transcripts: d.transcripts, sessions: d.sessions });
  });
  es.addEventListener("delta", (m) => onEvent({ type: "delta", text: data(m).text }));
  es.addEventListener("done", (m) => {
    const d = data(m);
    onEvent({ type: "done", report: d.report, degraded: !!d.degraded, scanned: d.signalSummary?.sessionsScanned });
    es.close();
  });
  es.addEventListener("failed", (m) => { onEvent({ type: "failed", message: data(m).message }); es.close(); });
  es.addEventListener("error", () => onEvent({ type: "failed", message: "stream connection error" }));

  return () => es.close();
}
