// packages/console/src/panels/Observe/BreakdownCard.tsx
import type { ObservePayload } from "../../api/routes.js";
import { fmtTokens } from "./data.js";
import { timeAgo } from "../../util/timeAgo.js";

type ProjectRow = ObservePayload["byProject"][number];
type TopSessionRow = ObservePayload["topSessions"][number];

const splitTip = (r: { tokens: number; tokensIn: number; tokensOut: number; tokensCache: number }) =>
  `${fmtTokens(r.tokens)} — ${fmtTokens(r.tokensIn)} in · ${fmtTokens(r.tokensOut)} out · ${fmtTokens(r.tokensCache)} cache`;

// "Tokens by project" — facet-style persistent ranking (Variant B): rows come from the
// pre-project-filter aggregate, so the list survives its own click. The active row is
// highlighted; clicking it (or the header chip) clears the filter. `project === null`
// renders as a quiet, honest non-affordance — the null bucket is not filterable (9A).
export function TokensByProjectCard({ rows, activeProject, onPick, onClear }: {
  rows: ProjectRow[]; activeProject: string | undefined;
  onPick: (project: string) => void; onClear: () => void;
}) {
  const visible = rows.slice(0, 8);
  // Degenerate guard (3A): a lone unclickable Unassigned bar answers nothing.
  if (visible.length === 0 || (visible.length === 1 && visible[0].project === null)) return null;
  const total = rows.reduce((n, r) => n + r.tokens, 0); // share denominator (1A): Σ byProject, NOT pulse
  const max = visible[0].tokens || 1;
  return (
    <div className="obs-card">
      <div className="obs-breakdown-head">
        <div className="obs-card-title">Tokens by project</div>
        {activeProject !== undefined && (
          <button type="button" className="obs-breakdown-chip" aria-label="Clear project filter" onClick={onClear}>
            {activeProject} ✕
          </button>
        )}
      </div>
      <ul className="obs-usage-list">
        {visible.map((r) => {
          const active = r.project !== null && r.project === activeProject;
          const share = total > 0 ? ` · ${Math.round((r.tokens / total) * 100)}%` : "";
          return (
            <li key={r.project ?? " unassigned"} className={"obs-usage-row" + (active ? " is-active" : "")}
              aria-current={active || undefined}>
              <div className="obs-usage-head">
                {r.project === null
                  ? <span className="obs-usage-name obs-muted" title="sessions with no project metadata — not filterable">Unassigned</span>
                  : <button type="button" className="obs-usage-link obs-usage-name"
                      title={active ? `Clear filter: ${r.project}` : `Filter dashboard to ${r.project}`}
                      onClick={() => (active ? onClear() : onPick(r.project!))}>
                      {r.project}
                    </button>}
                <span className="obs-usage-count" title={splitTip(r)}>{fmtTokens(r.tokens)}{share}</span>
              </div>
              <span className="obs-usage-track"><span className="obs-usage-fill" style={{ width: `${(r.tokens / max) * 100}%` }} /></span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// "Top sessions" — top 8 by tokens; rows deep-link to the Sessions detail page.
// Stays mounted with an in-card empty line while a filter is active (3A) so the
// two-card row doesn't jump on every filter click.
export function TopSessionsCard({ rows, filterActive }: { rows: TopSessionRow[]; filterActive: boolean }) {
  if (rows.length === 0 && !filterActive) return null;
  const max = rows[0]?.tokens || 1;
  return (
    <div className="obs-card">
      <div className="obs-breakdown-head"><div className="obs-card-title">Top sessions</div></div>
      {rows.length === 0 ? (
        <p className="obs-muted obs-usage-series-empty">No sessions in this range.</p>
      ) : (
        <ul className="obs-usage-list">
          {rows.map((s) => (
            <li key={s.agent + ":" + s.sessionId} className="obs-usage-row">
              <div className="obs-usage-head">
                <button type="button" className="obs-usage-link obs-usage-name"
                  title={`Open session ${s.sessionId}`}
                  onClick={() => {
                    window.location.hash =
                      `#/sessions/${encodeURIComponent(s.agent)}/${encodeURIComponent(s.sessionId)}`;
                  }}>
                  {s.project ?? "Unassigned"}
                </button>
                <span className="obs-usage-count" title={splitTip(s)}>{fmtTokens(s.tokens)}</span>
              </div>
              <div className="obs-breakdown-meta">{s.model ?? "—"} · {s.sessionId.slice(0, 8)}… · {timeAgo(s.endMs)}</div>
              <span className="obs-usage-track"><span className="obs-usage-fill" style={{ width: `${(s.tokens / max) * 100}%` }} /></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
