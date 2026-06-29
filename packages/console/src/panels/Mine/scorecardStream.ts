// Scorecard scan stream (named SSE events: start/progress/done/failed), consumed
// via native EventSource — same shape as analyzeStream.ts.
import type { Scorecard } from "../../api/routes.js";

export type ScorecardStreamEvent =
  | { type: "start"; total: number }
  | { type: "progress"; done: number; total: number; label: string; partial: { breadth: number; battleTested: number; portable: number } }
  | { type: "done"; scorecard: Scorecard; cached: boolean }
  | { type: "failed"; message: string };

export function openScorecardStream(
  apiBase: string,
  onEvent: (e: ScorecardStreamEvent) => void,
  opts?: { fresh?: boolean },
): () => void {
  const params = new URLSearchParams();
  if (opts?.fresh) params.set("fresh", "1");
  const qs = params.toString();
  const es = new EventSource(`${apiBase}/api/scorecard/stream${qs ? `?${qs}` : ""}`);
  const data = (m: Event) => JSON.parse((m as MessageEvent).data);

  es.addEventListener("start", (m) => onEvent({ type: "start", total: data(m).total }));
  es.addEventListener("progress", (m) => {
    const d = data(m);
    onEvent({ type: "progress", done: d.done, total: d.total, label: d.label, partial: d.partial });
  });
  es.addEventListener("done", (m) => {
    const d = data(m);
    onEvent({ type: "done", scorecard: d.scorecard, cached: !!d.cached });
    es.close();
  });
  es.addEventListener("failed", (m) => { onEvent({ type: "failed", message: data(m).message }); es.close(); });
  es.addEventListener("error", () => onEvent({ type: "failed", message: "stream connection error" }));

  return () => es.close();
}
