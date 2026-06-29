import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { AggIngredient } from "../types";
import { prettifyId, kindLabel, verifiedShare, barWidths, filterRows } from "../data";

const KINDS = [
  { value: "all", label: "All" },
  { value: "skill", label: "Skill" },
  { value: "mcp", label: "MCP" },
];

export function Leaderboard({ api }: { api: ReturnType<typeof makeApi> }) {
  const [rows, setRows] = useState<AggIngredient[]>([]);
  const [kind, setKind] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    api.getPopularity(kind === "all" ? {} : { kind })
      .then((r) => { if (alive) setRows(r); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, kind]);

  const widths = barWidths(rows.map((r) => r.producers));
  const visible = filterRows(rows, search);

  return (
    <div className="ex-board">
      <div className="ex-tabs">
        {KINDS.map((k) => (
          <button key={k.value} type="button"
            className={"ex-tab" + (k.value === kind ? " is-active" : "")}
            onClick={() => setKind(k.value)}>{k.label}</button>
        ))}
      </div>
      <input className="ex-search" type="search" aria-label="search ingredients"
        placeholder="filter the leaderboard…" value={search}
        onChange={(e) => setSearch(e.target.value)} />
      {error && <p className="ex-error">Couldn&apos;t load the leaderboard: {error}</p>}
      {!error && loading && rows.length === 0 && <p className="ex-empty">Loading…</p>}
      {!error && !loading && rows.length === 0 && <p className="ex-empty">No ingredients above the k-anonymity floor yet.</p>}
      {rows.length > 0 && visible.length === 0 && <p className="ex-empty">No ingredients match &quot;{search}&quot;.</p>}
      <ol className="ex-rows">
        {visible.map(({ row: r, rank }) => {
          const p = prettifyId(r.id, r.kind);
          return (
            <li key={r.id}>
              <a className="ex-row" href={"/ingredient/" + encodeURIComponent(r.id)}>
                <span className="ex-rank">{rank}</span>
                <span className="ex-name">{p.name}{p.scope && <span className="ex-scope">{p.scope}</span>}</span>
                <span className="ex-kind">{kindLabel(r.kind)}</span>
                <span className="ex-bar"><span className="ex-bar-fill" style={{ width: `${(widths[rank - 1] * 100).toFixed(0)}%` }} /></span>
                <span className="ex-counts">{r.producers} producers · {r.verifiedProducers} verified ✓</span>
                <span className="ex-vshare"><span className="ex-vshare-fill" style={{ width: `${(verifiedShare(r.producers, r.verifiedProducers) * 100).toFixed(0)}%` }} /></span>
              </a>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
