import { useEffect, useMemo, useRef, useState } from "react";
import { openEventStream, type FeedEvent } from "./eventStream.js";
import { HygieneNudge } from "./HygieneNudge.js";
import { Turn } from "../Observe/turnTree.js";
import type { TranscriptTurn } from "../../api/routes.js";

// Fold the append-only event stream into transcript-shaped turns so the live Feed
// renders through the same Turn tree as the History drill-down (Observe/turnTree).
// Each message starts its own turn; tool_calls attach to the current assistant turn
// (a synthetic one when the stream starts mid-session); a tool_result pairs back
// onto its call by toolId, landing output on the call span — `output === undefined`
// is what the tree reads as "still running". Pure over `events`, so React
// re-derives it whenever the stream grows.
export function toTurns(events: FeedEvent[]): TranscriptTurn[] {
  type ToolSpan = Extract<TranscriptTurn["spans"][number], { kind: "tool_call" }>;
  const zero = () => ({ in: 0, out: 0, cache: 0 }); // feed events carry no token counts; the chip hides at 0
  const turns: TranscriptTurn[] = [];
  const byTool = new Map<string, ToolSpan>();
  let current: TranscriptTurn | null = null;
  const assistant = (e: FeedEvent): TranscriptTurn => {
    if (!current) {
      current = { id: `t${e.index}`, role: "assistant", tsMs: e.tsMs, spans: [], tokens: zero() };
      turns.push(current);
    }
    return current;
  };
  for (const e of events) {
    const s = e.span;
    if (s.kind === "message") {
      const turn: TranscriptTurn = {
        id: `t${e.index}`, role: s.role, tsMs: e.tsMs,
        spans: [{ kind: "message", role: s.role, text: s.text }], tokens: zero(),
      };
      turns.push(turn);
      current = s.role === "assistant" ? turn : null;
    } else if (s.kind === "tool_call") {
      const span: ToolSpan = { kind: "tool_call", name: s.name, input: s.input };
      assistant(e).spans.push(span);
      if (s.toolId) byTool.set(s.toolId, span);
    } else {
      const call = s.toolId ? byTool.get(s.toolId) : undefined;
      if (call) { call.output = s.output; call.error = s.error; }
      else assistant(e).spans.push({ kind: "tool_call", name: "result", input: "", output: s.output, error: s.error });
    }
  }
  return turns;
}

// The live activity feed for one session: the History turn tree fed by the stream.
export function SessionFeed({ apiBase, file }: { apiBase: string; file: string }) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [phase, setPhase] = useState<string>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [following, setFollowing] = useState(true);
  const listRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    setEvents([]); setPhase("connecting"); setError(null); setCollapsed(new Set()); setFollowing(true);
    return openEventStream(apiBase, file, (m) => {
      if (m.type === "phase") setPhase(m.phase);
      else if (m.type === "failed") { setError(m.message); setPhase(""); }
      else setEvents((prev) => [...prev, m.event]); // append-only, ordered by index
    });
  }, [apiBase, file]);

  const turns = useMemo(() => toTurns(events), [events]);
  const startMs = events[0]?.tsMs ?? 0;

  // Follow the tail like a terminal: stick to the bottom as events stream in, let
  // go the moment the user scrolls up to read history, and resume via "↓ Live".
  useEffect(() => {
    const el = listRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [events.length, following]);
  const onScroll = () => {
    const el = listRef.current;
    if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  const toggle = (id: string) =>
    setCollapsed((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });

  return (
    <div>
      <HygieneNudge apiBase={apiBase} file={file} />
      <div className="run-status" style={{ gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        {phase && !error && <span className="run-badge run-running">{phase}</span>}
        {!following && turns.length > 0 && (
          <button type="button" className="ledger-view" onClick={() => setFollowing(true)}>↓ Live</button>
        )}
      </div>
      {error && <p className="ledger-error" role="alert">{error}</p>}
      {turns.length === 0 && !error && <p className="ledger-empty">Waiting for session activity…</p>}
      <ol className="feed tv-turns" ref={listRef} onScroll={onScroll}>
        {turns.map((t) => (
          <Turn key={t.id} turn={t} startMs={startMs} open={!collapsed.has(t.id)} onToggle={() => toggle(t.id)} live />
        ))}
      </ol>
    </div>
  );
}
