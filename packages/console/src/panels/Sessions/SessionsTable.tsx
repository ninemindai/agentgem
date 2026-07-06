import React, { useState } from "react";
import type { ObservePayload } from "../../api/routes.js";
import { fmtTokens, fmtDuration, fmtTime, flameLevel, utcDay } from "../Observe/data.js";

type SortKey = "tokens" | "msgs" | "durationMs" | "endMs";
const COL_COUNT = 8; // caret + project, agent, model, dur, msgs, tokens, recency

/** The session ledger: sortable table of runs with an expandable detail row and a
 *  transcript drill-down (#/sessions/<agent>/<sessionId>). Extracted from the old
 *  Inspect dashboard so Inspect can be a pure usage view. */
export function SessionsTable({ data }: { data: ObservePayload }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "endMs", dir: "desc" });
  const [openId, setOpenId] = useState<string | null>(null);

  function toggleSort(key: SortKey) {
    setSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });
  }

  const rows = [...data.sessions].sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    return sort.dir === "asc" ? av - bv : bv - av;
  });
  const maxTok = Math.max(0, ...rows.map(r => r.tokens));

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
            <th style={{ width: 24 }} />
            <th>project</th>
            <th>agent</th>
            <th>model</th>
            <SortTh label="dur" col="durationMs" sort={sort} onSort={toggleSort} />
            <SortTh label="msgs" col="msgs" sort={sort} onSort={toggleSort} />
            <SortTh label="tokens" col="tokens" sort={sort} onSort={toggleSort} />
            <SortTh label="recency" col="endMs" sort={sort} onSort={toggleSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const rowId = s.agent + "|" + s.sessionId;
            const isOpen = openId === rowId;
            const flames = flameLevel(s.tokens, maxTok);
            return (
              <React.Fragment key={rowId}>
                <tr
                  role="button"
                  tabIndex={0}
                  style={{ cursor: "pointer" }}
                  onClick={() => setOpenId(isOpen ? null : rowId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setOpenId(isOpen ? null : rowId);
                    }
                  }}
                >
                  <td><span className={"obs-caret" + (isOpen ? " open" : "")}>▸</span></td>
                  <td>
                    {s.project ?? "—"}
                    {flames > 0 && <span className="obs-flame" aria-hidden="true">{"🔥".repeat(flames)}</span>}
                  </td>
                  <td><span className="obs-chip">{s.agent}</span></td>
                  <td className="obs-muted">{s.model ?? "—"}</td>
                  <td>{fmtDuration(s.durationMs)}</td>
                  <td>{s.msgs}</td>
                  <td>{fmtTokens(s.tokens)}</td>
                  <td className="obs-muted">{s.endMs ? utcDay(s.endMs) : "—"}</td>
                </tr>
                {isOpen && (
                  <tr key={rowId + ":detail"} className="obs-detail">
                    <td colSpan={COL_COUNT}>
                      <span>in {fmtTokens(s.tokensIn)} · out {fmtTokens(s.tokensOut)} · cache {fmtTokens(s.tokensCache)}</span>
                      <span className="obs-detail-sep"> · </span>
                      <span>{fmtTime(s.startMs)} → {fmtTime(s.endMs)} ({fmtDuration(s.durationMs)})</span>
                      <span className="obs-detail-sep"> · </span>
                      <span>branch <strong>{s.gitBranch ?? "—"}</strong></span>
                      <span className="obs-detail-sep"> · </span>
                      <span>model <strong>{s.model ?? "—"}</strong></span>
                      <span className="obs-detail-sep"> · </span>
                      <span>agent <strong>{s.agent}</strong></span>
                      <span className="obs-detail-sep"> · </span>
                      <span>session <code>{s.sessionId.slice(0, 8)}…</code></span>
                      <button
                        type="button"
                        className="obs-open-transcript"
                        onClick={(e) => {
                          e.stopPropagation();
                          window.location.hash = `#/sessions/${s.agent}/${encodeURIComponent(s.sessionId)}`;
                        }}
                      >
                        Open transcript →
                      </button>
                    </td>
                  </tr>
                )}
              </React.Fragment>
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
