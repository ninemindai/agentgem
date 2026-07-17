// packages/console/src/panels/Observe/Dashboard.tsx
import { useState, type ReactNode } from "react";
import {
  ResponsiveContainer, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, type TooltipValueType,
} from "recharts";
import type { ObservePayload, ObserveRange, ObserveFilter } from "../../api/routes.js";
import { fmtTokens, fmtDuration, tokenSeries, heatmapCells, heatmapMonths } from "./data.js";
import { TokensByProjectCard, TopSessionsCard } from "./BreakdownCard.js";
import { RangeTabs, ObserveFilters } from "./ObserveControls.js";
import { RefreshButton } from "../../shell/RefreshButton.js";
import { QuickShareButton } from "../_shared/QuickShareButton.js";
import { setupLink, type SetupType } from "../Setup/link.js";

const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const SLICE_COLORS = ["var(--accent)", "var(--emerald, #34d399)", "#f59e0b", "#8b5cf6", "#ec4899", "#64748b"];

// A tooltip value is `number | string | ReadonlyArray<number | string> | undefined`, and
// Tooltip is not generic, so a formatter cannot narrow it away. Every series charted here
// is numeric; anything else renders as-is rather than reaching fmtTokens' arithmetic.
const fmtTokenValue = (v: TooltipValueType | undefined): string =>
  typeof v === "number" ? fmtTokens(v) : String(v ?? "");

// The per-session ledger table lives in the Sessions screen (panels/Sessions). Inspect is
// the aggregate usage view: pulse, activity/token charts, by-model, and the heatmap.
export function Dashboard({ data, range, onRange, filter, onFilter, pending, onRefresh, apiBase, resolveSetupShare, onPublishSetup }: {
  data: ObservePayload; range: ObserveRange; onRange: (r: ObserveRange) => void;
  filter: ObserveFilter; onFilter: (f: ObserveFilter) => void; pending?: boolean;
  onRefresh?: () => void; apiBase: string;
  resolveSetupShare?: () => Promise<{ name: string; provenance: string }>;
  onPublishSetup?: () => void;
}) {
  const [heatMetric, setHeatMetric] = useState<"tokens" | "sessions">("tokens");
  const [usageDim, setUsageDim] = useState<"tools" | "skills" | "subagents">("skills");

  const empty = data.pulse.sessions === 0;
  const heatCells = heatmapCells(data.daily, heatMetric);
  const colCount = heatCells.length > 0 ? Math.max(...heatCells.map(c => c.week)) + 1 : 0;
  const months = heatmapMonths(heatCells);

  return (
    <div className="obs">
      <div className="obs-head">
        <h2 className="obs-title">Overview</h2>
        {pending && <span className="obs-pending-pill">Updating…</span>}
        <RangeTabs range={range} onRange={onRange} />
        {resolveSetupShare && (
          /* Light path: resolve builds provenance from a fresh inventory scan at
             click time. The header "Publish ↗" is the persistent upgrade path, so
             no post-mint nudge here. */
          <QuickShareButton
            apiBase={apiBase}
            name="my-setup"
            provenance=""
            title="My agent setup"
            resolve={resolveSetupShare}
          />
        )}
        {onPublishSetup && (
          <button type="button" className="obs-range-btn obs-share-setup" onClick={onPublishSetup}>
            Publish ↗
          </button>
        )}
        {onRefresh && <RefreshButton onClick={onRefresh} busy={pending} />}
      </div>

      <ObserveFilters data={data} filter={filter} onFilter={onFilter} />

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
                    <Tooltip formatter={fmtTokenValue} />
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
                    <Tooltip formatter={fmtTokenValue} />
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

            {(() => {
              const attrFilterActive =
                filter.agent !== undefined || filter.project !== undefined || filter.model !== undefined;
              if (data.byProject.length === 0 && data.topSessions.length === 0 && !attrFilterActive) return null;
              return (
                <div className="obs-breakdown-section">
                  <div className="obs-card-title obs-breakdown-title">Where tokens went</div>
                  <div className="obs-breakdown-charts">
                    <TokensByProjectCard
                      rows={data.byProject} activeProject={filter.project}
                      onPick={(p) => onFilter({ ...filter, project: p })}
                      onClear={() => onFilter({ ...filter, project: undefined })}
                    />
                    <TopSessionsCard rows={data.topSessions} filterActive={attrFilterActive} />
                  </div>
                </div>
              );
            })()}

            {(data.byTool.length > 0 || data.bySubagent.length > 0 || data.bySkill.length > 0) && (
              <>
                <div className="obs-charts obs-usage-charts">
                  <UsageBars title="By tool" rows={data.byTool} />
                  <UsageBars title="By subagent" rows={data.bySubagent} linkTo="subagents" />
                  <UsageBars title="By skill" rows={data.bySkill} linkTo="skills" />
                </div>
                <UsageSeries data={data} dim={usageDim} onDim={setUsageDim} />
              </>
            )}

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
          </>
        )}
      </div>
    </div>
  );
}

const USAGE_DIM_LABEL = { tools: "Tools", skills: "Skills", subagents: "Subagents" } as const;
type UsageDim = "tools" | "skills" | "subagents";

// Stacked-area time-series of the top-6 artifacts of the chosen dimension over the range's
// days, from the aggregated usageDaily series.
function UsageSeries({ data, dim, onDim }: { data: ObservePayload; dim: UsageDim; onDim: (d: UsageDim) => void }) {
  const breakdown = dim === "tools" ? data.byTool : dim === "skills" ? data.bySkill : data.bySubagent;
  const names = breakdown.slice(0, 6).map((x) => x.name);
  const series = data.usageDaily.map((d) => {
    const row: Record<string, number | string> = { date: d.date };
    for (const n of names) row[n] = d[dim][n] ?? 0;
    return row;
  });
  return (
    <div className="obs-card obs-usage-series-card">
      <div className="obs-heatmap-head">
        <div className="obs-card-title">Usage over time</div>
        <div className="obs-heat-toggle" role="group" aria-label="usage dimension">
          {(["tools", "skills", "subagents"] as const).map((d) => (
            <button key={d} type="button" className={"obs-heat-toggle-btn" + (dim === d ? " is-active" : "")} onClick={() => onDim(d)}>
              {USAGE_DIM_LABEL[d]}
            </button>
          ))}
        </div>
      </div>
      {names.length === 0 ? (
        <p className="obs-muted obs-usage-series-empty">No {USAGE_DIM_LABEL[dim].toLowerCase()} usage in this range.</p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={series}>
              <CartesianGrid strokeOpacity={0.1} vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} width={28} allowDecimals={false} />
              <Tooltip />
              {names.map((n, i) => (
                <Area key={n} dataKey={n} stackId="u" stroke={SLICE_COLORS[i % SLICE_COLORS.length]} fill={SLICE_COLORS[i % SLICE_COLORS.length]} fillOpacity={0.5} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
          <ul className="obs-legend obs-usage-series-legend">
            {names.map((n, i) => (
              <li key={n}><span className="obs-dot" style={{ background: SLICE_COLORS[i % SLICE_COLORS.length] }} />{n}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="obs-stat"><div className="obs-stat-value">{value}</div><div className="obs-stat-label">{label}</div></div>;
}
// A ranked usage breakdown (top 8) — used for By tool / By subagent / By skill. When
// `linkTo` is set, each name deep-links straight to that artifact's viewer in the Setup
// browser (using the bare name after any `plugin:` prefix, which matches inventory names).
function UsageBars({ title, rows, linkTo }: { title: string; rows: { name: string; count: number }[]; linkTo?: SetupType }) {
  if (!rows.length) return null;
  const max = rows[0].count || 1;
  const viewInSetup = (name: string) => { window.location.hash = setupLink(linkTo!, name.split(":").pop() ?? name); };
  return (
    <div className="obs-card obs-usage-card">
      <div className="obs-card-title">{title}</div>
      <ul className="obs-usage-list">
        {rows.slice(0, 8).map((r) => (
          <li key={r.name} className="obs-usage-row">
            <div className="obs-usage-head">
              {linkTo
                ? <button type="button" className="obs-usage-name obs-usage-link" title={`View ${r.name} in Setup`} onClick={() => viewInSetup(r.name)}>{r.name}</button>
                : <span className="obs-usage-name" title={r.name}>{r.name}</span>}
              <span className="obs-usage-count">{r.count}</span>
            </div>
            <span className="obs-usage-track"><span className="obs-usage-fill" style={{ width: `${(r.count / max) * 100}%` }} /></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
function Card({ title, children }: { title: string; children: ReactNode }) {
  return <div className="obs-card"><div className="obs-card-title">{title}</div>{children}</div>;
}
