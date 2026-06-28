// Session-analysis workflow stream (named SSE events: phase/delta/done/failed),
// consumed via native EventSource — same shape as the run stream.

export type AnalyzeEvent =
  | { type: "phase"; phase: string; transcripts?: number; sessions?: number }
  | { type: "delta"; text: string }
  | { type: "done"; cached: boolean }
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
  const data = (m: Event) => JSON.parse((m as MessageEvent).data);

  es.addEventListener("phase", (m) => {
    const d = data(m);
    onEvent({ type: "phase", phase: d.phase, transcripts: d.transcripts, sessions: d.sessions });
  });
  es.addEventListener("delta", (m) => onEvent({ type: "delta", text: data(m).text }));
  es.addEventListener("done", (m) => { onEvent({ type: "done", cached: !!data(m).cached }); es.close(); });
  es.addEventListener("failed", (m) => { onEvent({ type: "failed", message: data(m).message }); es.close(); });
  es.addEventListener("error", () => onEvent({ type: "failed", message: "stream connection error" }));

  return () => es.close();
}
