import { useEffect, useMemo, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { inventoryRoute, usageRoute, buildGemRoute, archiveRoute, createWorkspaceRoute, scaffoldChecksRoute, testbedImportRoute, makeClient, type Usage, type Gem, type GemCheck } from "../../api/routes.js";
import { groupInventory, mergeUsage, applyView, relativeTime, DEFAULT_VIEW, type LedgerGroup, type SortKey } from "./data.js";
import { selKey, visibleKeys, buildSelection, type GemSelection } from "./selection.js";
import { takeRecommendedSelection } from "../../recommendation.js";
import { base64ToBytes, downloadBlob, copyText } from "./exporters.js";
import { Preview } from "./Preview.js";
import { Targets } from "./Targets.js";
import { Run } from "./Run.js";
import { Checks } from "./Checks.js";
import { ContentView } from "./ContentView.js";
import { Publish } from "./Publish.js";

export function Ledger({ apiBase }: { apiBase: string }) {
  const [groups, setGroups] = useState<LedgerGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState(DEFAULT_VIEW);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [gem, setGem] = useState<Gem | null>(null);
  const [builtSel, setBuiltSel] = useState<GemSelection | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [wsName, setWsName] = useState("");
  const [wsNote, setWsNote] = useState<string | null>(null);
  const [importRoot, setImportRoot] = useState("");
  const [importNote, setImportNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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

  // Consume a recommendation handed over from the Testbed analyze (once, on mount):
  // pre-select its artifacts and reveal all so unused recommendations are visible.
  useEffect(() => {
    const keys = takeRecommendedSelection();
    if (keys && keys.length) {
      setSelected(new Set(keys));
      setView((v) => ({ ...v, usedOnly: false }));
    }
  }, []);

  const visible = useMemo(() => (groups ? applyView(groups, view) : []), [groups, view]);
  const total = useMemo(() => (groups ?? []).reduce((n, g) => n + g.items.length, 0), [groups]);
  // Clicking the active sort flips its direction; clicking the other switches to it (desc).
  const setSort = (sort: SortKey) => setView((v) =>
    v.sort === sort ? { ...v, dir: v.dir === "desc" ? "asc" : "desc" } : { ...v, sort, dir: "desc" },
  );
  const arrow = (key: SortKey) => (view.sort === key ? (view.dir === "desc" ? " ↓" : " ↑") : "");

  const toggle = (key: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });
  const selectAllShown = () => setSelected((s) => new Set([...s, ...visibleKeys(visible)]));
  const clearSelection = () => setSelected(new Set());
  const toggleExpand = (key: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const build = async () => {
    setBuilding(true);
    setBuildError(null);
    try {
      const client = makeClient(apiBase);
      const sel = buildSelection(selected);
      const checks = (suggested ?? []).filter((c) => included.has(c.name));
      const g = await buildGemRoute.call(client, { body: { selection: sel, name: "gem", checks: checks.length ? checks : undefined } });
      setGem(g);
      setBuiltSel(sel);
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  };

  const saveWorkspace = async () => {
    const name = wsName.trim();
    if (!name || selected.size === 0) return;
    setWsNote(null);
    setBuildError(null);
    try {
      await createWorkspaceRoute.call(makeClient(apiBase), { body: { name, selection: buildSelection(selected) } });
      setWsNote(`saved workspace “${name}”`);
      setWsName("");
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : String(e));
    }
  };

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

  const importToTestbed = async () => {
    const root = importRoot.trim();
    if (!root || selected.size === 0) return;
    setImportNote(null);
    try {
      const r = await testbedImportRoute.call(makeClient(apiBase), { body: { root, selection: buildSelection(selected) } });
      setImportNote(`imported ${r.written.length} → ${root}${r.skipped.length ? ` (${r.skipped.length} skipped)` : ""}`);
    } catch (e) {
      setImportNote(null);
      setBuildError(e instanceof Error ? e.message : String(e));
    }
  };

  const copyJson = () => { if (gem) void copyText(JSON.stringify(gem, null, 2)); };
  const downloadJson = () => { if (gem) downloadBlob(`${gem.name}.json`, "application/json", JSON.stringify(gem, null, 2)); };
  const downloadGem = async () => {
    if (!gem || !builtSel) return;
    const client = makeClient(apiBase);
    const { tarGz } = await archiveRoute.call(client, { body: { selection: builtSel, name: gem.name, tar: true } });
    if (tarGz) downloadBlob(`${gem.name}.gem`, "application/gzip", base64ToBytes(tarGz));
  };

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
        >Uses{arrow("uses")}</button>
        <button
          type="button"
          className={"ledger-sort" + (view.sort === "last" ? " is-active" : "")}
          onClick={() => setSort("last")}
        >Last used{arrow("last")}</button>
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
        <button
          type="button"
          className="ledger-build"
          disabled={selected.size === 0 || building}
          onClick={build}
        >{building ? "Building…" : "Build Gem"}</button>
        <input
          className="ledger-search ws-name-input"
          type="text"
          aria-label="workspace name"
          placeholder="workspace name…"
          value={wsName}
          onChange={(e) => setWsName(e.target.value)}
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
        <div className="ledger-selbar">
          <span className="targets-label">Import to testbed</span>
          <input
            className="ledger-search"
            type="text"
            aria-label="testbed import root"
            placeholder="/path/to/testbed"
            value={importRoot}
            onChange={(e) => setImportRoot(e.target.value)}
          />
          <button type="button" className="ledger-sort" disabled={!importRoot.trim()} onClick={importToTestbed}>Import</button>
          {importNote && <span className="ws-note">{importNote}</span>}
        </div>
      )}

      {selected.size > 0 && (
        <Checks suggested={suggested} included={included} busy={checksBusy} error={checksError} onSuggest={suggestChecks} onToggle={toggleCheck} />
      )}

      {gem && (
        <Preview gem={gem} onDownloadGem={downloadGem} onDownloadJson={downloadJson} onCopyJson={copyJson} />
      )}
      {gem && builtSel && <Targets apiBase={apiBase} selection={builtSel} name={gem.name} />}
      {gem && builtSel && <Run apiBase={apiBase} selection={builtSel} name={gem.name} />}
      {gem && builtSel && <Publish apiBase={apiBase} selection={builtSel} name={gem.name} />}

      {visible.length === 0 ? (
        <p className="ledger-empty">{emptyMsg}</p>
      ) : visible.map((g) => (
        <section className="ledger-group" key={g.key}>
          <h2 className="ledger-group-label">{g.label}</h2>
          <ul className="ledger-items">
            {g.items.map((i) => {
              const key = selKey(g.key, i.name);
              return (
                <li className="ledger-item-wrap" key={i.name}>
                  <div className="ledger-item">
                    <label className="ledger-item-main">
                      <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
                      <span className="ledger-item-name">{i.name}</span>
                    </label>
                    {i.detail && (
                      <button type="button" className="ledger-view" onClick={() => toggleExpand(key)}>
                        {expanded.has(key) ? "hide" : "view"}
                      </button>
                    )}
                    {i.lastUsedMs != null && (
                      <span className="ledger-last" title="last used">{relativeTime(i.lastUsedMs)}</span>
                    )}
                    <span className="ledger-badge" title="invocations">{i.invocations}</span>
                  </div>
                  {i.detail && expanded.has(key) && (
                    g.key === "skills" || g.key === "instructions"
                      ? <ContentView text={i.detail} />
                      : <pre className="ledger-detail">{i.detail}</pre>
                  )}
                </li>
              );
            })}
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
  group: "build",
  route: "#/ledger",
  component: ({ apiBase }) => <Ledger apiBase={apiBase} />,
});
