// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Visual companions for the Insights text report: an outcomes donut (mostly /
// partial / not) and a per-model stacked bar. Reuses recharts — the same
// dependency the Inspect dashboard already renders with. Pure/presentational;
// tolerant of empty data so a thin report never breaks the panel.
import { ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, Legend } from "recharts";
import type { InsightsReportView } from "./insightsStream.js";

const OUTCOME = {
  mostly: { label: "mostly", color: "var(--emerald, #34d399)" },
  partially: { label: "partial", color: "#f59e0b" },
  not: { label: "not", color: "#94a3b8" },
} as const;

type Totals = InsightsReportView["totals"];
type ByModel = InsightsReportView["by_model"];

/** Donut of the session-outcome mix, with a text legend so it reads even where
 *  the chart can't measure itself (e.g. jsdom / zero-size containers). */
export function OutcomesDonut({ totals }: { totals: Totals }) {
  const slices = [
    { key: "mostly", value: totals.mostly },
    { key: "partially", value: totals.partially },
    { key: "not", value: totals.not },
  ].filter((s) => s.value > 0);
  if (slices.length === 0) return null;
  return (
    <div className="insights-chart">
      <h4>Outcomes</h4>
      <ResponsiveContainer width="100%" height={160}>
        <PieChart>
          <Pie data={slices} dataKey="value" nameKey="key" innerRadius={44} outerRadius={64} paddingAngle={2}>
            {slices.map((s) => <Cell key={s.key} fill={OUTCOME[s.key as keyof typeof OUTCOME].color} />)}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
      <ul className="insights-legend">
        {slices.map((s) => {
          const o = OUTCOME[s.key as keyof typeof OUTCOME];
          return (
            <li key={s.key}>
              <span className="insights-swatch" style={{ background: o.color }} aria-hidden="true" />
              {o.label} <strong>{s.value}</strong>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Stacked outcome bars per model — the local cross-model success view. */
export function ByModelBars({ byModel }: { byModel: ByModel }) {
  if (!byModel || byModel.length === 0) return null;
  const data = byModel.map((m) => ({ model: m.model, mostly: m.mostly, partial: m.partially, not: m.not }));
  return (
    <div className="insights-chart">
      <ResponsiveContainer width="100%" height={Math.max(120, data.length * 44)}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 8 }}>
          <XAxis type="number" allowDecimals={false} hide />
          <YAxis type="category" dataKey="model" width={140} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend />
          <Bar dataKey="mostly" stackId="o" fill={OUTCOME.mostly.color} />
          <Bar dataKey="partial" stackId="o" fill={OUTCOME.partially.color} />
          <Bar dataKey="not" stackId="o" fill={OUTCOME.not.color} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
