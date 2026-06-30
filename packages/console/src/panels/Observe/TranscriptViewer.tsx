// packages/console/src/panels/Observe/TranscriptViewer.tsx
//
// Per-session drill-down (Inspect Phase 2): a hierarchical turn -> span tree that
// replays one session in time order, with verbatim (scrubbed) message text, tool
// I/O, and per-turn token/cost chips. Reads the lazy, scrubbed transcript route;
// reuses the obs-* token family so it sits inside the existing Inspect styling.
import { useEffect, useState } from "react";
import { inspectSessionRoute, makeClient, type TranscriptView, type TranscriptTurn, type TranscriptSpan } from "../../api/routes.js";
import { fmtTokens, fmtDuration } from "./data.js";
import { Loading } from "../../shell/Loading.js";

export function TranscriptViewer({ apiBase, agent, sessionId, onBack }: {
  apiBase: string; agent: "claude" | "codex"; sessionId: string; onBack: () => void;
}) {
  const [view, setView] = useState<TranscriptView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    setView(null); setError(null);
    inspectSessionRoute.call(makeClient(apiBase), { query: { id: sessionId, agent } })
      .then((v) => { if (alive) setView(v); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [apiBase, agent, sessionId]);

  const toggle = (id: string) =>
    setCollapsed((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const allCollapsed = view ? collapsed.size >= view.turns.length : false;
  const setAll = () => {
    if (!view) return;
    setCollapsed(allCollapsed ? new Set() : new Set(view.turns.map((t) => t.id)));
  };

  return (
    <div className="obs tv">
      <div className="tv-head">
        <button type="button" className="tv-back" onClick={onBack}>← Inspect</button>
        {view && (
          <>
            <h2 className="obs-title tv-title">{view.meta.project ?? "session"}</h2>
            <span className="obs-chip">{view.agent}</span>
            <span className="obs-muted tv-meta">
              {view.meta.model ?? "—"} · {fmtDuration(view.meta.endMs - view.meta.startMs)} · {view.meta.msgs} msgs ·{" "}
              {fmtTokens(view.meta.tokensIn + view.meta.tokensOut)} tokens
            </span>
            {view.turns.length > 0 && (
              <button type="button" className="obs-sort-btn tv-collapse" onClick={setAll}>
                {allCollapsed ? "Expand all" : "Collapse all"}
              </button>
            )}
          </>
        )}
      </div>

      {error ? (
        <p className="obs-error">Couldn't load session: {error}</p>
      ) : !view ? (
        <Loading />
      ) : view.turns.length === 0 ? (
        <p className="obs-empty">This session has no readable turns.</p>
      ) : (
        <ol className="tv-turns">
          {view.turns.map((turn) => (
            <Turn key={turn.id} turn={turn} startMs={view.meta.startMs}
              open={!collapsed.has(turn.id)} onToggle={() => toggle(turn.id)} />
          ))}
        </ol>
      )}
    </div>
  );
}

function Turn({ turn, startMs, open, onToggle }: {
  turn: TranscriptTurn; startMs: number; open: boolean; onToggle: () => void;
}) {
  const tok = turn.tokens.in + turn.tokens.out;
  return (
    <li className={"tv-turn role-" + turn.role}>
      <button type="button" className="tv-turn-head" aria-expanded={open} onClick={onToggle}>
        <span className={"obs-caret" + (open ? " open" : "")}>▸</span>
        <span className="tv-role">{turn.role}</span>
        <span className="tv-summary">{summarize(turn)}</span>
        <span className="tv-when obs-muted">{relTime(turn.tsMs - startMs)}</span>
        {tok > 0 && <span className="tv-tok obs-chip">{fmtTokens(tok)}</span>}
      </button>
      {open && (
        <div className="tv-spans">
          {turn.spans.map((span, i) => <Span key={i} span={span} />)}
        </div>
      )}
    </li>
  );
}

function Span({ span }: { span: TranscriptSpan }) {
  if (span.kind === "message") {
    return <pre className={"tv-msg role-" + span.role}>{span.text}</pre>;
  }
  return <ToolCall span={span} />;
}

function ToolCall({ span }: { span: Extract<TranscriptSpan, { kind: "tool_call" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={"tv-tool" + (span.error ? " is-error" : "")}>
      <button type="button" className="tv-tool-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={"obs-caret" + (open ? " open" : "")}>▸</span>
        <span className="tv-tool-name">{span.name}</span>
        {span.error && <span className="tv-tool-err">error</span>}
      </button>
      {open && (
        <div className="tv-tool-body">
          <div className="tv-tool-label obs-muted">input</div>
          <pre className="tv-io">{span.input}</pre>
          {span.output !== undefined && (
            <>
              <div className="tv-tool-label obs-muted">output</div>
              <pre className="tv-io">{span.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// One-line preview of a turn for the collapsed header.
function summarize(turn: TranscriptTurn): string {
  const first = turn.spans[0];
  if (!first) return "";
  if (first.kind === "message") return firstLine(first.text);
  const tools = turn.spans.filter((s) => s.kind === "tool_call").map((s) => (s as { name: string }).name);
  return tools.length === 1 ? tools[0] : `${tools.length} tool calls: ${tools.slice(0, 3).join(", ")}`;
}

function firstLine(s: string): string {
  const line = s.split("\n", 1)[0];
  return line.length > 120 ? line.slice(0, 119) + "…" : line;
}

// Relative offset from session start, e.g. "+0s", "+1m12s", "+1h03m".
function relTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `+${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `+${m}m${String(rs).padStart(2, "0")}s`;
  const h = Math.floor(m / 60), rm = m % 60;
  return `+${h}h${String(rm).padStart(2, "0")}m`;
}
