import { useState } from "react";
import type { ObservePayload } from "../../api/routes.js";
import { fmtTokens, fmtDuration, flameLevel, utcDay } from "../Observe/data.js";
import { SessionSummaryPopover, type SessionActivity } from "./SessionSummaryPopover.js";
import { SESSION_HYGIENE_SHORTCUT, launchRubricRun } from "../../rubricShortcuts.js";

type SortKey = "tokens" | "msgs" | "durationMs" | "endMs";

const EMPTY_ACTIVITY: SessionActivity = { tools: {}, skills: {}, subagents: {} };

/** The session ledger: sortable table of runs. Hover or focus a row for its
 *  activity skeleton; click (or Enter/Space) a row to open that session's
 *  transcript (#/sessions/<agent>/<sessionId>). */
export function SessionsTable({ data, activity }: {
  data: ObservePayload;
  activity: Map<string, SessionActivity>;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "endMs", dir: "desc" });
  const [hoverId, setHoverId] = useState<string | null>(null);

  function toggleSort(key: SortKey) {
    setSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });
  }

  const rows = [...data.sessions].sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    return sort.dir === "asc" ? av - bv : bv - av;
  });
  const maxTok = Math.max(0, ...rows.map(r => r.tokens));

  const open = (agent: string, sessionId: string) => {
    window.location.hash = `#/sessions/${agent}/${encodeURIComponent(sessionId)}`;
  };

  return (
    <div className="obs-table-wrap">
      {data.pulse.sessions > rows.length && (
        <p className="obs-muted obs-table-hint">
          Showing {rows.length} of {data.pulse.sessions} sessions (most recent)
        </p>
      )}
      <table className="obs-table">
        <thead>
          <tr>
            <th>project</th>
            <th>agent</th>
            <th>model</th>
            <SortTh label="dur" col="durationMs" sort={sort} onSort={toggleSort} />
            <SortTh label="msgs" col="msgs" sort={sort} onSort={toggleSort} />
            <SortTh label="tokens" col="tokens" sort={sort} onSort={toggleSort} />
            <SortTh label="recency" col="endMs" sort={sort} onSort={toggleSort} />
            <th aria-label="shortcuts" />
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => {
            const rowId = s.agent + ":" + s.sessionId;
            const up = i === rows.length - 1;
            const flames = flameLevel(s.tokens, maxTok);
            return (
              <tr
                key={rowId}
                role="button"
                tabIndex={0}
                style={{ cursor: "pointer" }}
                onClick={() => open(s.agent, s.sessionId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(s.agent, s.sessionId); }
                  else if (e.key === "Escape") { setHoverId(null); }
                }}
                onMouseEnter={() => setHoverId(rowId)}
                onMouseLeave={() => setHoverId((h) => (h === rowId ? null : h))}
                onFocus={() => setHoverId(rowId)}
                onBlur={() => setHoverId((h) => (h === rowId ? null : h))}
              >
                <td style={{ position: "relative" }}>
                  {s.project ?? "—"}
                  {flames > 0 && <span className="obs-flame" aria-hidden="true">{"🔥".repeat(flames)}</span>}
                  {hoverId === rowId && (
                    <SessionSummaryPopover activity={activity.get(rowId) ?? EMPTY_ACTIVITY} up={up} />
                  )}
                </td>
                <td><span className="obs-chip">{s.agent}</span></td>
                <td className="obs-muted">{s.model ?? "—"}</td>
                <td>{fmtDuration(s.durationMs)}</td>
                <td>{s.msgs}</td>
                <td>{fmtTokens(s.tokens)}</td>
                <td className="obs-muted">{s.endMs ? utcDay(s.endMs) : "—"}</td>
                <td>
                  {/* Rubric shortcut — claude sessions only: the rubric engine reads claude transcripts. */}
                  {s.agent === "claude" && (
                    <button
                      type="button"
                      className="obs-sort-btn"
                      title={SESSION_HYGIENE_SHORTCUT.title}
                      onKeyDown={(e) => e.stopPropagation()} // keep Enter/Space off the row's open-transcript handler
                      onClick={(e) => {
                        e.stopPropagation(); // the row itself opens the transcript
                        launchRubricRun({
                          rubric: SESSION_HYGIENE_SHORTCUT.rubric,
                          scope: "session",
                          sessionId: s.sessionId,
                          label: s.project ? `${s.project} · ${s.sessionId.slice(0, 8)}…` : s.sessionId,
                        });
                      }}
                    >
                      {SESSION_HYGIENE_SHORTCUT.label}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SortTh({ label, col, sort, onSort }: {
  label: string; col: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (k: SortKey) => void;
}) {
  const active = sort.key === col;
  return (
    <th aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={"obs-sort-btn" + (active ? " is-active" : "")} onClick={() => onSort(col)}>
        {label}{active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
}
