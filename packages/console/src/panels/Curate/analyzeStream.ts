// Session-analysis workflow stream (named SSE events: phase/delta/done/failed),
// consumed via native EventSource — same shape as the run stream.

export interface AnalyzeCandidate {
  name: string;
  description: string;
  confidence: string;
  include: { type: string; name: string }[];
}

export type AnalyzeEvent =
  | { type: "phase"; phase: string; transcripts?: number; sessions?: number }
  | { type: "delta"; text: string }
  | { type: "done"; cached: boolean; candidates: AnalyzeCandidate[] }
  | { type: "failed"; message: string };

export function openAnalyzeStream(
  apiBase: string,
  root: string,
  fresh: boolean,
  onEvent: (e: AnalyzeEvent) => void,
): () => void {
  const params = new URLSearchParams({ root });
  if (fresh) params.set("fresh", "1");
  const es = new EventSource(`${apiBase}/api/workflow/analyze/stream?${params.toString()}`);
  // Parse safely: a malformed frame must never throw out of a listener. For phase/delta that would drop
  // the frame, but for the terminal done/failed events the throw skips es.close() and the terminal event,
  // freezing the UI on a stream that never completes.
  const data = (m: Event): any | undefined => {
    try { return JSON.parse((m as MessageEvent).data); } catch { return undefined; }
  };

  es.addEventListener("phase", (m) => {
    const d = data(m);
    if (d) onEvent({ type: "phase", phase: d.phase, transcripts: d.transcripts, sessions: d.sessions });
  });
  es.addEventListener("delta", (m) => { const d = data(m); if (d) onEvent({ type: "delta", text: d.text }); });
  es.addEventListener("done", (m) => {
    const d = data(m);
    es.close();
    if (d) onEvent({ type: "done", cached: !!d.cached, candidates: Array.isArray(d.candidates) ? d.candidates : [] });
    else onEvent({ type: "failed", message: "malformed done frame" });
  });
  es.addEventListener("failed", (m) => { const d = data(m); es.close(); onEvent({ type: "failed", message: d?.message ?? "stream failed" }); });
  es.addEventListener("error", () => onEvent({ type: "failed", message: "stream connection error" }));

  return () => es.close();
}
