// Watch Dashboard-mode data layer: subscribe to one session's living HTML dashboard
// via EventSource — named events phase/rendering/render/failed. Mirror of eventStream.ts.
export type DashMsg =
  | { type: "phase"; phase: string; agent: string }
  | { type: "rendering" }
  | { type: "render"; html: string; version: number }
  | { type: "failed"; message: string };

export function openDashboardStream(apiBase: string, file: string, onEvent: (e: DashMsg) => void): () => void {
  const es = new EventSource(`${apiBase}/api/watch/dashboard?${new URLSearchParams({ file })}`);
  const data = (m: Event) => JSON.parse((m as MessageEvent).data);
  es.addEventListener("phase", (m) => { const d = data(m); onEvent({ type: "phase", phase: d.phase, agent: d.agent }); });
  es.addEventListener("rendering", () => onEvent({ type: "rendering" }));
  es.addEventListener("render", (m) => { const d = data(m); onEvent({ type: "render", html: d.html, version: d.version }); });
  // A render failure is RECOVERABLE (keep last, retry next burst) — only close on a fatal
  // failure (out-of-scope / unsupported agent), else the stream dies on the first hiccup (#3).
  es.addEventListener("failed", (m) => { const d = data(m); onEvent({ type: "failed", message: d.message }); if (d.fatal) es.close(); });
  es.addEventListener("error", () => onEvent({ type: "failed", message: "connection lost" }));
  return () => es.close();
}
