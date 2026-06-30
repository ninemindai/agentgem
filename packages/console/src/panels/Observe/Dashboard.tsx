// packages/console/src/panels/Observe/Dashboard.tsx
import React, { useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import type { ObservePayload, ObserveRange, ObserveFilter } from "../../api/routes.js";
import { fmtTokens, fmtDuration, tokenSeries, fmtTime, flameLevel, heatmapCells, heatmapMonths, utcDay } from "./data.js";
import { RefreshButton } from "../../shell/RefreshButton.js";

const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];

const RANGES: ObserveRange[] = ["today", "7d", "30d", "all"];
const RANGE_LABEL: Record<ObserveRange, string> = { today: "Today", "7d": "7d", "30d": "30d", all: "All" };
const SLICE_COLORS = ["var(--accent)", "var(--emerald, #34d399)", "#f59e0b", "#8b5cf6", "#ec4899", "#64748b"];

type SortKey = "tokens" | "msgs" | "durationMs" | "endMs";

export function Dashboard({ data, range, onRange, filter, onFilter, pending, onRefresh }: {
  data: ObservePayload; range: ObserveRange; onRange: (r: ObserveRange) => void;
  filter: ObserveFilter; onFilter: (f: ObserveFilter) => void; pending?: boolean;
  onRefresh?: () => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "endMs", dir: "desc" });
  const [openId, setOpenId] = useState<string | null>(null);
  const [heatMetric, setHeatMetric] = useState<"tokens" | "sessions">("tokens");

  const empty = data.pulse.sessions === 0;

  function toggleSort(key: SortKey) {
    setSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });
  }

  const rows = [...data.sessions].sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    return sort.dir === "asc" ? av - bv : bv - av;
  });

  const maxTok = Math.max(0, ...rows.map(r => r.tokens));
  const heatCells = heatmapCells(data.daily, heatMetric);
  const colCount = heatCells.length > 0 ? Math.max(...heatCells.map(c => c.week)) + 1 : 0;
  const months = heatmapMonths(heatCells);
  const COL_COUNT = 8; // caret + project, agent, model, dur, msgs, tokens, recency

  return (
    <div className="obs">
      <div className="obs-head">
        <h2 className="obs-title">Inspect</h2>
        {pending && <span className="obs-pending-pill">Updating…</span>}
        <div className="obs-range" role="tablist" aria-label="time range">
          {RANGES.map((r) => (
            <button key={r} type="button" role="tab" aria-selected={r === range} tabIndex={r === range ? 0 : -1}
              className={"obs-range-btn" + (r === range ? " is-active" : "")} onClick={() => onRange(r)}>
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
        {onRefresh && <RefreshButton onClick={onRefresh} busy={pending} />}
      </div>

      <div className="obs-filters">
        <select aria-label="agent" value={filter.agent ?? ""}
          onChange={e => onFilter({ ...filter, agent: e.target.value || undefined })}>
          <option value="">All agents</option>
          {data.facets.agents.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <select aria-label="project" value={filter.project ?? ""}
          onChange={e => onFilter({ ...filter, project: e.target.value || undefined })}>
          <option value="">All projects</option>
          {data.facets.projects.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select aria-label="model" value={filter.model ?? ""}
          onChange={e => onFilter({ ...filter, model: e.target.value || undefined })}>
          <option value="">All models</option>
          {data.facets.models.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <label className="obs-filter-num">
          min msgs
          <input type="number" min={0} aria-label="minimum messages per session" placeholder="any"
            value={filter.minMsgs ?? ""}
            onChange={e => onFilter({ ...filter, minMsgs: e.target.value === "" ? undefined : Number(e.target.value) })} />
        </label>
      </div>

      <div className={"obs-body" + (pending ? " is-updating" : "")}>
        <div className="obs-pulse">
          <Stat label="sessions" value={String(data.pulse.sessions)} />
          <Stat label="messages" value={String(data.pulse.msgs)} />
          <Stat label="tokens" value={fmtTokens(data.pulse.tokens)} />
          <Stat label="active" value={fmtDuration(data.pulse.activeMs)} />
        </div>

        {empty ? (
          <p className="obs-empty">No agent sessions found yet for this range.</p>
        ) : (
          <>
            <div className="obs-charts">
              <Card title="Activity (sessions/day)">
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={data.daily}>
                    <CartesianGrid strokeOpacity={0.1} vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} width={28} />
                    <Tooltip />
                    <Bar dataKey="sessions" fill="var(--accent)" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Card>

              <Card title="Tokens (in / out / cache)">
                <ResponsiveContainer width="100%" height={160}>
                  <AreaChart data={tokenSeries(data.daily)}>
                    <CartesianGrid strokeOpacity={0.1} vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} width={36} tickFormatter={fmtTokens} />
                    <Tooltip formatter={(v: number) => fmtTokens(v)} />
                    <Area dataKey="in" stackId="t" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.5} />
                    <Area dataKey="out" stackId="t" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.5} />
                    <Area dataKey="cache" stackId="t" stroke="#64748b" fill="#64748b" fillOpacity={0.4} />
                  </AreaChart>
                </ResponsiveContainer>
              </Card>

              <Card title="By model">
                <ResponsiveContainer width="100%" height={160}>
                  <PieChart>
                    <Pie data={data.models} dataKey="tokens" nameKey="model" innerRadius={36} outerRadius={60} paddingAngle={2}>
                      {data.models.map((m, i) => <Cell key={m.agent + "|" + m.model} fill={SLICE_COLORS[i % SLICE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v: number) => fmtTokens(v)} />
                  </PieChart>
                </ResponsiveContainer>
                <ul className="obs-legend">
                  {data.models.map((m, i) => (
                    <li key={m.agent + "|" + m.model}>
                      <span className="obs-dot" style={{ background: SLICE_COLORS[i % SLICE_COLORS.length] }} />
                      {m.model} · {m.agent} <span className="obs-muted">({m.sessions})</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>

            {heatCells.length > 0 && (
              <div className="obs-card obs-heatmap-card">
                <div className="obs-heatmap-head">
                  <div className="obs-card-title">Activity heatmap</div>
                  <div className="obs-heat-toggle" role="group" aria-label="heatmap metric">
                    <button type="button"
                      className={"obs-heat-toggle-btn" + (heatMetric === "tokens" ? " is-active" : "")}
                      onClick={() => setHeatMetric("tokens")}>Tokens</button>
                    <button type="button"
                      className={"obs-heat-toggle-btn" + (heatMetric === "sessions" ? " is-active" : "")}
                      onClick={() => setHeatMetric("sessions")}>Sessions</button>
                  </div>
                </div>
                <div className="obs-heat-wrap">
                  {/* Month X-axis markers above the grid */}
                  <div className="obs-heat-months-row">
                    <div className="obs-heat-weekday-gutter" />
                    <div className="obs-heat-months" style={{ gridTemplateColumns: `repeat(${colCount}, 1fr)` }}>
                      {months.map(({ week, label }) => (
                        <div key={week} className="obs-heat-month-label" style={{ gridColumn: week + 1 }}>
                          {label}
                        </div>
                      ))}
                    </div>
                  </div>
                  {/* Weekday Y-axis labels + heat grid */}
                  <div className="obs-heat-main">
                    <div className="obs-heat-weekdays" aria-hidden="true">
                      {WEEKDAY_LABELS.map((label, i) => (
                        <div key={i} className="obs-heat-weekday-label">{label}</div>
                      ))}
                    </div>
                    <div
                      className="obs-heat"
                      style={{
                        gridTemplateRows: "repeat(7, 1fr)",
                        gridTemplateColumns: `repeat(${colCount}, 1fr)`,
                      }}
                    >
                      {heatCells.map((cell) => (
                        <div
                          key={cell.date}
                          className={"obs-heat-cell lvl-" + cell.level}
                          style={{ gridRow: cell.weekday + 1, gridColumn: cell.week + 1 }}
                          title={`${cell.date}: ${cell.sessions} sessions · ${fmtTokens(cell.tokens)} tokens`}
                        />
                      ))}
                    </div>
                  </div>
                  {/* Less → More legend */}
                  <div className="obs-heat-legend">
                    <span>Less</span>
                    <span className="obs-heat-swatch lvl-1" />
                    <span className="obs-heat-swatch lvl-2" />
                    <span className="obs-heat-swatch lvl-3" />
                    <span className="obs-heat-swatch lvl-4" />
                    <span>More</span>
                    <span className="obs-muted">&nbsp;·&nbsp;by {heatMetric}</span>
                  </div>
                </div>
              </div>
            )}

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
                                  window.location.hash = `#/inspect/${s.agent}/${encodeURIComponent(s.sessionId)}`;
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
          </>
        )}
      </div>
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

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="obs-stat"><div className="obs-stat-value">{value}</div><div className="obs-stat-label">{label}</div></div>;
}
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="obs-card"><div className="obs-card-title">{title}</div>{children}</div>;
}
