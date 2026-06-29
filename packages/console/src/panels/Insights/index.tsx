import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import {
  popularityRoute, overviewRoute, makeClient,
  type AggIngredient, type AggOverview,
} from "../../api/routes.js";
import { Pulse } from "./Pulse.js";
import { Leaderboard } from "./Leaderboard.js";
import { Detail } from "./Detail.js";

export function Insights({ apiBase }: { apiBase: string }) {
  const [overview, setOverview] = useState<AggOverview | null>(null);
  const [rows, setRows] = useState<AggIngredient[]>([]);
  const [kind, setKind] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let alive = true;
    const client = makeClient(apiBase);
    overviewRoute.call(client).then((o) => { if (alive) setOverview(o); }).catch(() => { if (alive) setOverview(null); });
    return () => { alive = false; };
  }, [apiBase]);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    const client = makeClient(apiBase);
    popularityRoute.call(client, { query: kind === "all" ? {} : { kind } })
      .then((r) => { if (alive) setRows(r); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [kind, apiBase]);

  return (
    <div className="ins">
      <Pulse data={overview} loading={overview === null} />
      <div className="ins-split">
        <div className="ins-left">
          {error && <p className="ins-error">Couldn't load insights: {error}</p>}
          {loading && rows.length === 0 ? <div className="ins-empty">Loading…</div>
            : <Leaderboard rows={rows} kind={kind} onKind={setKind} selectedId={selectedId} onSelect={setSelectedId} search={search} onSearch={setSearch} />}
        </div>
        <div className="ins-right">
          {selectedId ? <Detail id={selectedId} apiBase={apiBase} />
            : <div className="ins-detail ins-detail-empty">Select an ingredient to see how it's used and growing.</div>}
        </div>
      </div>
    </div>
  );
}

export const insightsPage = defineConsolePage({
  id: "insights", title: "Insights", icon: "📊", order: 25, group: "library",
  route: "#/insights", component: Insights,
});
