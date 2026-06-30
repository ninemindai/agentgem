// packages/console/src/panels/Observe/TranscriptDiff.tsx
//
// Side-by-side transcript comparison (phase 4): two sessions (or a run vs. a
// reference run) in aligned columns with changed-region highlighting. Pure
// client-side alignment (see diff.ts) over two TranscriptViews; reuses the
// viewer's Span renderer and the obs-* palette.
import { useEffect, useState } from "react";
import { inspectSessionRoute, makeClient, type TranscriptView } from "../../api/routes.js";
import { Span, summarize } from "./TranscriptViewer.js";
import { alignTurns, diffCounts, type DiffRow } from "./diff.js";
import { Loading } from "../../shell/Loading.js";

type Ref = { agent: "claude" | "codex"; sessionId: string };

export function TranscriptDiff({ apiBase, a, b, onBack }: {
  apiBase: string; a: Ref; b: Ref; onBack: () => void;
}) {
  const [va, setVa] = useState<TranscriptView | null>(null);
  const [vb, setVb] = useState<TranscriptView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setVa(null); setVb(null); setError(null);
    const client = makeClient(apiBase);
    Promise.all([
      inspectSessionRoute.call(client, { query: { id: a.sessionId, agent: a.agent } }),
      inspectSessionRoute.call(client, { query: { id: b.sessionId, agent: b.agent } }),
    ])
      .then(([ra, rb]) => { if (alive) { setVa(ra); setVb(rb); } })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [apiBase, a.agent, a.sessionId, b.agent, b.sessionId]);

  return (
    <div className="obs tv tv-diff">
      <div className="tv-head">
        <button type="button" className="tv-back" onClick={onBack}>← Inspect</button>
        <h2 className="obs-title tv-title">Compare runs</h2>
        {va && vb && (
          <span className="obs-muted tv-meta">
            {label(va)} vs {label(vb)}
          </span>
        )}
      </div>

      {error ? (
        <p className="obs-error">Couldn't load comparison: {error}</p>
      ) : !va || !vb ? (
        <Loading />
      ) : (
        <Diff va={va} vb={vb} />
      )}
    </div>
  );
}

function Diff({ va, vb }: { va: TranscriptView; vb: TranscriptView }) {
  const rows = alignTurns(va.turns, vb.turns);
  const c = diffCounts(rows);
  return (
    <>
      <div className="tv-diff-legend obs-muted">
        <span className="lvl-same">{c.same} same</span>
        <span className="lvl-changed">{c.changed} changed</span>
        <span className="lvl-added">+{c.added} added</span>
        <span className="lvl-removed">−{c.removed} removed</span>
      </div>
      <div className="tv-diff-colhead">
        <div>{va.meta.project ?? "A"}</div>
        <div>{vb.meta.project ?? "B"}</div>
      </div>
      <ol className="tv-diff-rows">
        {rows.map((r, i) => <Row key={i} row={r} />)}
      </ol>
    </>
  );
}

function Row({ row }: { row: DiffRow }) {
  const [open, setOpen] = useState(false);
  const expandable = !!(row.a || row.b);
  return (
    <li className={"tv-diff-row status-" + row.status}>
      <button type="button" className="tv-diff-rowhead" aria-expanded={open}
        onClick={() => expandable && setOpen((o) => !o)}>
        <Cell turn={row.a} muted={row.status === "added"} />
        <span className="tv-diff-mark" aria-hidden="true">{MARK[row.status]}</span>
        <Cell turn={row.b} muted={row.status === "removed"} />
      </button>
      {open && (
        <div className="tv-diff-detail">
          <div className="tv-diff-pane">{row.a ? row.a.spans.map((s, i) => <Span key={i} span={s} />) : <Empty />}</div>
          <div className="tv-diff-pane">{row.b ? row.b.spans.map((s, i) => <Span key={i} span={s} />) : <Empty />}</div>
        </div>
      )}
    </li>
  );
}

const MARK: Record<DiffRow["status"], string> = { same: "=", changed: "≠", added: "+", removed: "−" };

function Cell({ turn, muted }: { turn: DiffRow["a"]; muted: boolean }) {
  if (!turn) return <span className="tv-diff-cell is-empty" />;
  return (
    <span className={"tv-diff-cell" + (muted ? " is-muted" : "")}>
      <span className="tv-role">{turn.role}</span>
      <span className="tv-summary">{summarize(turn)}</span>
    </span>
  );
}

function Empty() { return <p className="obs-muted tv-diff-empty">— (no matching turn)</p>; }

function label(v: TranscriptView): string {
  return `${v.meta.project ?? v.agent} (${v.sessionId.slice(0, 8)})`;
}
