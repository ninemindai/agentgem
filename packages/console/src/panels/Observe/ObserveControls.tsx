import type { ObservePayload, ObserveRange, ObserveFilter } from "../../api/routes.js";

const RANGES: ObserveRange[] = ["today", "7d", "30d", "all"];
const RANGE_LABEL: Record<ObserveRange, string> = { today: "Today", "7d": "7d", "30d": "30d", all: "All" };

/** Time-range tabs — shared by Inspect (charts) and Sessions (the ledger). */
export function RangeTabs({ range, onRange }: { range: ObserveRange; onRange: (r: ObserveRange) => void }) {
  return (
    <div className="obs-range" role="tablist" aria-label="time range">
      {RANGES.map((r) => (
        <button key={r} type="button" role="tab" aria-selected={r === range} tabIndex={r === range ? 0 : -1}
          className={"obs-range-btn" + (r === range ? " is-active" : "")} onClick={() => onRange(r)}>
          {RANGE_LABEL[r]}
        </button>
      ))}
    </div>
  );
}

/** Agent / project / model / min-msgs filters — shared by Inspect and Sessions. */
export function ObserveFilters({ data, filter, onFilter }: {
  data: ObservePayload; filter: ObserveFilter; onFilter: (f: ObserveFilter) => void;
}) {
  return (
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
  );
}
