// packages/console/src/panels/Observe/Dashboard.tsx
import {
  ResponsiveContainer, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import type { ObservePayload, ObserveRange } from "../../api/routes.js";
import { fmtTokens, fmtDuration, tokenSeries } from "./data.js";

const RANGES: ObserveRange[] = ["today", "7d", "30d", "all"];
const RANGE_LABEL: Record<ObserveRange, string> = { today: "Today", "7d": "7d", "30d": "30d", all: "All" };
const SLICE_COLORS = ["var(--accent)", "var(--emerald, #34d399)", "#f59e0b", "#8b5cf6", "#ec4899", "#64748b"];

export function Dashboard({ data, range, onRange }: { data: ObservePayload; range: ObserveRange; onRange: (r: ObserveRange) => void }) {
  const empty = data.pulse.sessions === 0;
  return (
    <div className="obs">
      <div className="obs-head">
        <h2 className="obs-title">Observe</h2>
        <div className="obs-range" role="tablist" aria-label="time range">
          {RANGES.map((r) => (
            <button key={r} type="button" role="tab" aria-selected={r === range}
              className={"obs-range-btn" + (r === range ? " is-active" : "")} onClick={() => onRange(r)}>
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

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
                    {data.models.map((_, i) => <Cell key={i} fill={SLICE_COLORS[i % SLICE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmtTokens(v)} />
                </PieChart>
              </ResponsiveContainer>
              <ul className="obs-legend">
                {data.models.map((m, i) => (
                  <li key={m.agent + m.model}>
                    <span className="obs-dot" style={{ background: SLICE_COLORS[i % SLICE_COLORS.length] }} />
                    {m.model} <span className="obs-muted">({m.sessions})</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <div className="obs-table-wrap">
            <table className="obs-table">
              <thead><tr><th>project</th><th>agent</th><th>model</th><th>dur</th><th>msgs</th><th>tokens</th></tr></thead>
              <tbody>
                {data.sessions.map((s) => (
                  <tr key={s.agent + s.sessionId}>
                    <td>{s.project ?? "—"}</td>
                    <td><span className="obs-chip">{s.agent}</span></td>
                    <td className="obs-muted">{s.model ?? "—"}</td>
                    <td>{fmtDuration(s.durationMs)}</td>
                    <td>{s.msgs}</td>
                    <td>{fmtTokens(s.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="obs-stat"><div className="obs-stat-value">{value}</div><div className="obs-stat-label">{label}</div></div>;
}
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="obs-card"><div className="obs-card-title">{title}</div>{children}</div>;
}
