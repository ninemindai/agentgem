import { useEffect, useMemo, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { inventoryRoute, usageRoute, makeClient, type Usage } from "../../api/routes.js";
import { groupInventory, mergeUsage, applyView, DEFAULT_VIEW, type LedgerGroup, type SortKey } from "./data.js";

export function Ledger({ apiBase }: { apiBase: string }) {
  const [groups, setGroups] = useState<LedgerGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState(DEFAULT_VIEW);

  useEffect(() => {
    let alive = true;
    const client = makeClient(apiBase);
    (async () => {
      try {
        const inv = await inventoryRoute.call(client);
        let usage: Usage = { artifacts: [] };
        try { usage = await usageRoute.call(client); } catch { /* usage badges are optional */ }
        if (alive) setGroups(mergeUsage(groupInventory(inv), usage));
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [apiBase]);

  const visible = useMemo(() => (groups ? applyView(groups, view) : []), [groups, view]);
  const total = useMemo(() => (groups ?? []).reduce((n, g) => n + g.items.length, 0), [groups]);
  const setSort = (sort: SortKey) => setView((v) => ({ ...v, sort }));

  if (error) return <p className="ledger-error">Could not load inventory: {error}</p>;
  if (!groups) return <p className="ledger-loading">Loading…</p>;

  // "Used only" hiding everything (e.g. no usage analyzed yet) is the common
  // empty case — point at the toggle rather than implying the ledger is empty.
  const emptyMsg = view.usedOnly && !view.query && total > 0
    ? `No used artifacts yet — uncheck “Used only” to browse all ${total}.`
    : "No matching artifacts.";

  return (
    <div className="ledger">
      <div className="ledger-bar">
        <input
          className="ledger-search"
          type="text"
          placeholder="search names…"
          aria-label="search"
          value={view.query}
          onChange={(e) => setView((v) => ({ ...v, query: e.target.value }))}
        />
        <button
          type="button"
          className={"ledger-sort" + (view.sort === "uses" ? " is-active" : "")}
          onClick={() => setSort("uses")}
        >Uses</button>
        <button
          type="button"
          className={"ledger-sort" + (view.sort === "last" ? " is-active" : "")}
          onClick={() => setSort("last")}
        >Last used</button>
        <label className="ledger-usedonly">
          <input
            type="checkbox"
            checked={view.usedOnly}
            onChange={(e) => setView((v) => ({ ...v, usedOnly: e.target.checked }))}
          /> Used only
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="ledger-empty">{emptyMsg}</p>
      ) : visible.map((g) => (
        <section className="ledger-group" key={g.key}>
          <h2 className="ledger-group-label">{g.label}</h2>
          <ul className="ledger-items">
            {g.items.map((i) => (
              <li className="ledger-item" key={i.name}>
                <span className="ledger-item-name">{i.name}</span>
                <span className="ledger-badge" title="invocations">{i.invocations}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export const ledgerPage = defineConsolePage({
  id: "ledger",
  title: "Ledger",
  icon: "◆",
  order: 10,
  route: "#/ledger",
  component: ({ apiBase }) => <Ledger apiBase={apiBase} />,
});
