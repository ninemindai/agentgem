import { useEffect, useMemo, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { inventoryRoute, usageRoute, createWorkspaceRoute, scaffoldChecksRoute, makeClient, type Usage, type GemCheck } from "../../api/routes.js";
import { groupInventory, mergeUsage, applyView, sortGroupItems, relativeTime, formatSource, DEFAULT_VIEW, type LedgerGroup, type SortKey, type SortDir } from "./data.js";
import { selKey, visibleKeys, buildSelection } from "./selection.js";
import { useActiveGem, setKeys, toggleKey as toggleKeyStore, clearKeys, setName as setNameStore } from "../../activeGem.js";
import { Analyze } from "./Analyze.js";
import { Checks } from "./Checks.js";
import { ContentView } from "./ContentView.js";
import { Loading } from "../../shell/Loading.js";

export function Curate({ apiBase }: { apiBase: string }) {
  const [groups, setGroups] = useState<LedgerGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState(DEFAULT_VIEW);
  const { keys: selected, name: wsName } = useActiveGem();
  const [wsNote, setWsNote] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<"compose" | "suggest">("compose");
  const [suggested, setSuggested] = useState<GemCheck[] | null>(null);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [checksBusy, setChecksBusy] = useState(false);
  const [checksError, setChecksError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const client = makeClient(apiBase);
    (async () => {
      try {
        const inv = await inventoryRoute.call(client);
        let usage: Usage = { artifacts: [] };
        // scope:global aggregates usage across all projects; without it the count
        // is scoped to the server's cwd (usually empty for global artifacts).
        try { usage = await usageRoute.call(client, { query: { scope: "global" } }); } catch { /* usage badges are optional */ }
        if (alive) setGroups(mergeUsage(groupInventory(inv), usage));
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [apiBase]);

  const [groupSort, setGroupSort] = useState<Record<string, { sort: SortKey; dir: SortDir }>>({});
  const getSectionSort = (key: string) => groupSort[key] ?? { sort: "uses" as SortKey, dir: "desc" as SortDir };
  const setSectionSort = (key: string, sort: SortKey) => {
    const current = getSectionSort(key);
    const dir: SortDir = current.sort === sort ? (current.dir === "desc" ? "asc" : "desc") : "desc";
    setGroupSort((prev) => ({ ...prev, [key]: { sort, dir } }));
  };
  const sectionArrow = (key: string, sort: SortKey) => {
    const s = getSectionSort(key);
    return s.sort === sort ? (s.dir === "desc" ? " ↓" : " ↑") : "";
  };

  const visible = useMemo(() => {
    if (!groups) return [];
    return applyView(groups, view).map((g) => {
      const s = groupSort[g.key] ?? { sort: "uses" as SortKey, dir: "desc" as SortDir };
      return { ...g, items: sortGroupItems(g.items, s.sort, s.dir) };
    });
  }, [groups, view, groupSort]);
  const total = useMemo(() => (groups ?? []).reduce((n, g) => n + g.items.length, 0), [groups]);

  const toggle = (key: string) => toggleKeyStore(key);
  const selectAllShown = () => setKeys(new Set([...selected, ...visibleKeys(visible)]));
  const clearSelection = () => clearKeys();
  const toggleExpand = (key: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const saveWorkspace = async () => {
    const name = wsName.trim();
    if (!name || selected.size === 0) return;
    setWsNote(null);
    setBuildError(null);
    try {
      await createWorkspaceRoute.call(makeClient(apiBase), { body: { name, selection: buildSelection(selected) } });
      setWsNote(`saved workspace "${name}"`);
      setNameStore("");
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleCollapse = (key: string) => setCollapsed((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const suggestChecks = async () => {
    setChecksBusy(true);
    setChecksError(null);
    try {
      const { checks } = await scaffoldChecksRoute.call(makeClient(apiBase), { body: { selection: buildSelection(selected), name: "gem" } });
      setSuggested(checks);
      setIncluded(new Set(checks.map((c) => c.name)));
    } catch (e) {
      setChecksError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecksBusy(false);
    }
  };
  const toggleCheck = (name: string) => setIncluded((s) => {
    const n = new Set(s);
    if (n.has(name)) n.delete(name); else n.add(name);
    return n;
  });

  if (error) return <p className="ledger-error">Could not load inventory: {error}</p>;
  if (!groups) return <Loading />;

  // "Used only" hiding everything (e.g. no usage analyzed yet) is the common
  // empty case — point at the toggle rather than implying the ledger is empty.
  const emptyMsg = view.usedOnly && !view.query && total > 0
    ? `No used artifacts yet — uncheck "Used only" to browse all ${total}.`
    : "No matching artifacts.";

  return (
    <div className="ledger">
      <div className="curate-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={"curate-tab" + (tab === "compose" ? " is-active" : "")}
          aria-selected={tab === "compose"}
          onClick={() => setTab("compose")}
        >Compose from artifacts</button>
        <button
          type="button"
          role="tab"
          className={"curate-tab" + (tab === "suggest" ? " is-active" : "")}
          aria-selected={tab === "suggest"}
          onClick={() => setTab("suggest")}
        >Suggest from a project</button>
      </div>

      {tab === "suggest" && (
        <Analyze apiBase={apiBase} onPick={(picked) => { setKeys(new Set(picked)); setView((v) => ({ ...v, usedOnly: false })); setTab("compose"); }} />
      )}

      {tab === "compose" && (<>
      <div className="ledger-bar">
        <div className="ledger-search-wrap">
          <input
            className="ledger-search"
            type="text"
            placeholder="search names…"
            aria-label="search"
            value={view.query}
            onChange={(e) => setView((v) => ({ ...v, query: e.target.value }))}
          />
          {view.query && (
            <button
              type="button"
              className="ledger-search-clear"
              aria-label="clear search"
              onClick={() => setView((v) => ({ ...v, query: "" }))}
            >×</button>
          )}
        </div>
        <label className="ledger-usedonly">
          <input
            type="checkbox"
            checked={view.usedOnly}
            onChange={(e) => setView((v) => ({ ...v, usedOnly: e.target.checked }))}
          /> Used only
        </label>
      </div>

      <div className="ledger-selbar">
        <strong className="ledger-selcount">{selected.size} selected</strong>
        <button type="button" className="ledger-sort" onClick={selectAllShown}>Select all shown</button>
        <button type="button" className="ledger-sort" onClick={clearSelection}>Clear</button>
        <a className="ledger-build" href="#/materialize" style={{ textDecoration: "none" }}>Materialize →</a>
        <input
          className="ledger-search ws-name-input"
          type="text"
          aria-label="workspace name"
          placeholder="workspace name…"
          value={wsName}
          onChange={(e) => setNameStore(e.target.value)}
        />
        <button
          type="button"
          className="ledger-sort"
          disabled={!wsName.trim() || selected.size === 0}
          onClick={saveWorkspace}
        >Save workspace</button>
        {wsNote && <span className="ws-note">{wsNote}</span>}
        {buildError && <span className="ledger-error">{buildError}</span>}
      </div>

      {selected.size > 0 && (
        <Checks suggested={suggested} included={included} busy={checksBusy} error={checksError} onSuggest={suggestChecks} onToggle={toggleCheck} />
      )}

      {visible.length === 0 ? (
        <p className="ledger-empty">{emptyMsg}</p>
      ) : visible.map((g) => (
        <section className="ledger-group" key={g.key}>
          <button
            type="button"
            className="ledger-group-label ledger-group-toggle"
            aria-expanded={!collapsed.has(g.key)}
            onClick={() => toggleCollapse(g.key)}
          >
            <span className="ledger-group-caret">{collapsed.has(g.key) ? "▸" : "▾"}</span>
            {g.label}
            <span className="ledger-group-count">{g.items.length}</span>
          </button>
          {!collapsed.has(g.key) && (<>
          <div className="ledger-col-headers">
            <button type="button" className={"ledger-col-btn" + (getSectionSort(g.key).sort === "name" ? " is-active" : "")} onClick={() => setSectionSort(g.key, "name")}>Name{sectionArrow(g.key, "name")}</button>
            <button type="button" className={"ledger-col-btn" + (getSectionSort(g.key).sort === "uses" ? " is-active" : "")} onClick={() => setSectionSort(g.key, "uses")}>Uses{sectionArrow(g.key, "uses")}</button>
            <button type="button" className={"ledger-col-btn" + (getSectionSort(g.key).sort === "last" ? " is-active" : "")} onClick={() => setSectionSort(g.key, "last")}>Last used{sectionArrow(g.key, "last")}</button>
          </div>
          <ul className="ledger-items">
            {g.items.map((i) => {
              const key = selKey(g.key, i.name);
              const isExpanded = expanded.has(key);
              return (
                <li className="ledger-item-wrap" key={i.name}>
                  <div className="ledger-item">
                    <label className="ledger-item-main">
                      <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
                      <span className="ledger-item-name">{i.name}</span>
                    </label>
                    {i.source && <span className="ledger-source" title={i.source}>{formatSource(i.source)}</span>}
                    <span className="ledger-badge" title="invocations">{i.invocations}</span>
                    {i.lastUsedMs != null && (
                      <span className="ledger-last" title="last used">{relativeTime(i.lastUsedMs)}</span>
                    )}
                    {i.detail && (
                      <button type="button" className="ledger-view" aria-label={isExpanded ? "hide" : "view"} onClick={() => toggleExpand(key)}>
                        {isExpanded ? (
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                            <line x1="1" y1="1" x2="23" y2="23"/>
                          </svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                            <circle cx="12" cy="12" r="3"/>
                          </svg>
                        )}
                      </button>
                    )}
                  </div>
                  {i.detail && isExpanded && (
                    g.key === "skills" || g.key === "instructions"
                      ? <ContentView text={i.detail} />
                      : <pre className="ledger-detail">{i.detail}</pre>
                  )}
                </li>
              );
            })}
          </ul>
          </>)}
        </section>
      ))}
      </>)}
    </div>
  );
}

export const curatePage = defineConsolePage({
  id: "curate",
  title: "Curate",
  icon: "◆",
  order: 10,
  group: "build",
  route: "#/curate",
  component: ({ apiBase }) => <Curate apiBase={apiBase} />,
});
