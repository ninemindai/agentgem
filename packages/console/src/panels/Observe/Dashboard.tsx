// packages/console/src/panels/Observe/Dashboard.tsx
import { useState, type ReactNode } from "react";
import {
  ResponsiveContainer, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import type { ObservePayload, ObserveRange, ObserveFilter } from "../../api/routes.js";
import { fmtTokens, fmtDuration, tokenSeries, heatmapCells, heatmapMonths } from "./data.js";
import { RangeTabs, ObserveFilters } from "./ObserveControls.js";
import { RefreshButton } from "../../shell/RefreshButton.js";
import { QuickShareButton } from "../_shared/QuickShareButton.js";

const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const SLICE_COLORS = ["var(--accent)", "var(--emerald, #34d399)", "#f59e0b", "#8b5cf6", "#ec4899", "#64748b"];

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

  const empty = data.pulse.sessions === 0;
  const heatCells = heatmapCells(data.daily, heatMetric);
  const colCount = heatCells.length > 0 ? Math.max(...heatCells.map(c => c.week)) + 1 : 0;
  const months = heatmapMonths(heatCells);

  return (
    <div className="obs">
      <div className="obs-head">
        <h2 className="obs-title">Inspect</h2>
        {pending && <span className="obs-pending-pill">Updating…</span>}
        <RangeTabs range={range} onRange={onRange} />
        {onPublishSetup && (
          <button type="button" className="obs-range-btn obs-share-setup" onClick={onPublishSetup}>
            Publish ↗
          </button>
        )}
        {onRefresh && <RefreshButton onClick={onRefresh} busy={pending} />}
      </div>

      {resolveSetupShare && (
        <div className="obs-share-strip">
          {/* Light path: resolve builds provenance from a fresh inventory scan at
              click time. The header "Publish ↗" is the persistent upgrade path, so
              no post-mint nudge here. */}
          <QuickShareButton
            apiBase={apiBase}
            name="my-setup"
            provenance=""
            title="My agent setup"
            resolve={resolveSetupShare}
          />
        </div>
      )}

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
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="obs-stat"><div className="obs-stat-value">{value}</div><div className="obs-stat-label">{label}</div></div>;
}
function Card({ title, children }: { title: string; children: ReactNode }) {
  return <div className="obs-card"><div className="obs-card-title">{title}</div>{children}</div>;
}
