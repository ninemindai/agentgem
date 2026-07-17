import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { inventoryRoute, artifactContentRoute, makeClient, type Inventory, type Artifact } from "../../api/routes.js";
import { useSubRouteTabs } from "../../shell/useSubRouteTabs.js";
import { useCopied } from "../../shell/useCopied.js";
import { useDialogA11y } from "../../shell/useDialogA11y.js";
import { Loading } from "../../shell/Loading.js";
import { ContentView } from "../Curate/ContentView.js";
import { ScopePicker, type Scope } from "../_shared/ScopePicker.js";
import { SETUP_ROUTE, setupLink, type SetupType } from "./link.js";

// Read-only browser of the local .claude setup — the artifacts your agents run with.
// Everything (incl. each skill/subagent's SKILL.md `content`) comes from one /api/inventory
// scan, so the viewer just shows what's already loaded; no per-artifact fetch.
//
// Tabs are deep-linkable sub-routes: the Shell resolves #/setup/<tab> by longest-prefix match
// (same trick Gems uses), and an artifact is addressable as #/setup/<tab>?a=<name> so any other
// panel can link straight into its viewer. Dashboard's legacy #/setup?q=<name> still lands on
// the All tab, pre-filtered.
type TypeKey = SetupType;
type Tab = { id: string; label: string; route: string; key: TypeKey | null };

const TABS: Tab[] = [
  { id: "all", label: "All", route: "#/setup", key: null },
  { id: "skills", label: "Skills", route: SETUP_ROUTE.skills, key: "skills" },
  { id: "subagents", label: "Subagents", route: SETUP_ROUTE.subagents, key: "subagents" },
  { id: "mcp", label: "MCP servers", route: SETUP_ROUTE.mcpServers, key: "mcpServers" },
  { id: "hooks", label: "Hooks", route: SETUP_ROUTE.hooks, key: "hooks" },
  { id: "instructions", label: "Instructions", route: SETUP_ROUTE.instructions, key: "instructions" },
];
const TYPE_TABS = TABS.filter((t): t is Tab & { key: TypeKey } => t.key !== null);

// Muted category accents drawn from the shared palette (theme.css) — one dot per artifact type.
const DOT: Record<TypeKey, string> = {
  skills: "var(--purple)",
  subagents: "var(--pink)",
  mcpServers: "var(--teal)",
  hooks: "var(--gold)",
  instructions: "var(--blue)",
};
const PREVIEW = 6; // artifacts shown on each overview card before "View all →"

const ROUTES = TABS.map((t) => t.route);
// ?a= (open artifact) and ?q= (filter) live in the hash query, tracked separately from the
// path-driven tab (which useSubRouteTabs owns). A name/source/description substring test.
function parseQuery() {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  return { a: params.get("a"), q: params.get("q") };
}
const matches = (a: Artifact, needle: string) =>
  !needle || a.name.toLowerCase().includes(needle) ||
  (a.source ?? "").toLowerCase().includes(needle) ||
  (a.description ?? "").toLowerCase().includes(needle);

// Project-scope merge (see the inventory effect) tags each artifact with a `_layer`
// marker; only project-layer rows carry the badge — global ones render as before.
const LayerBadge = ({ a }: { a: Artifact }) =>
  (a as { _layer?: string })._layer === "project"
    ? <span className="opt-flag" title="project-local">project</span>
    : null;

export function Setup({ apiBase }: { apiBase: string }) {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { idx: tabIdx, go, roving } = useSubRouteTabs(ROUTES);
  const tab = TABS[tabIdx];
  const [openName, setOpenName] = useState<string | null>(() => parseQuery().a);
  const [q, setQ] = useState(() => parseQuery().q ?? "");
  const [scope, setScope] = useState<Scope>({ kind: "global" });
  const root = scope.kind === "project" ? scope.root : undefined;

  useEffect(() => {
    let alive = true;
    // The server's parseProjectsQuery expects a JSON-encoded array of roots, not a raw path.
    // ?body=defer drops artifact bodies from the top-level (global) lists — the viewer fetches
    // one by id when its modal opens. Project-layer artifacts have no entity-address scheme
    // yet, so the server leaves them with inline content regardless.
    inventoryRoute.call(makeClient(apiBase), { query: root ? { projects: JSON.stringify([root]), body: "defer" } : { body: "defer" } })
      .then((res) => {
        if (!alive) return;
        if (!root || !res.projects?.length) { setInv(res); return; }
        // Merge the project's artifacts into the flat lists so the existing type-tab
        // rendering shows both layers; tag each one so the badge can tell them apart.
        const proj = res.projects[0];
        const tag = (arr: Artifact[], layer: "global" | "project") => arr.map((a) => ({ ...a, _layer: layer }));
        setInv({
          ...res,
          skills: [...tag(res.skills, "global"), ...tag(proj.skills, "project")],
          mcpServers: [...tag(res.mcpServers, "global"), ...tag(proj.mcpServers, "project")],
          instructions: [...tag(res.instructions, "global"), ...tag(proj.instructions, "project")],
          hooks: [...tag(res.hooks, "global"), ...tag(proj.hooks, "project")],
          subagents: [...tag(res.subagents, "global"), ...tag(proj.subagents, "project")],
        } as Inventory);
      })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [apiBase, root]);

  useEffect(() => {
    const onHash = () => {
      const p = parseQuery();
      setOpenName(p.a); // a tab click / viewer close drops ?a, closing the viewer
      // A q param (legacy/cross-panel deep-filter like #/setup?q=name) drives the input; routes
      // without one — tab clicks, viewer open/close — leave the typed filter untouched.
      if (p.q !== null) setQ(p.q);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const openArtifact = (key: TypeKey, name: string) => { window.location.hash = setupLink(key, name); };
  const closeViewer = () => { window.location.hash = tab.route; };

  if (error) return <div className="obs"><p className="obs-error">Couldn't load setup: {error}</p></div>;
  if (!inv) return <div className="obs"><Loading /></div>;

  const needle = q.trim().toLowerCase();
  const items = (key: TypeKey): Artifact[] => (inv[key] as Artifact[]) ?? [];

  // Resolve the deep-linked artifact (?a=): active tab's type first, then every other type, so a
  // wrong-type or cross-panel link still opens instead of silently doing nothing.
  const selected = openName
    ? (() => {
        const order = tab.key
          ? [tab.key, ...TYPE_TABS.map((t) => t.key).filter((k) => k !== tab.key)]
          : TYPE_TABS.map((t) => t.key);
        for (const key of order) {
          const found = items(key).find((x) => x.name === openName);
          if (found) return { artifact: found, group: TYPE_TABS.find((t) => t.key === key)!.label };
        }
        return null;
      })()
    : null;
  const notFound = !!openName && !selected; // deep link to a name that isn't in the inventory
  // The list behind an open viewer ignores the filter, so the viewer never floats over a
  // "no matches" list; the filter reapplies (badge counts included) once it closes.
  const listNeedle = selected ? "" : needle;
  const count = (key: TypeKey) => listNeedle ? items(key).filter((a) => matches(a, listNeedle)).length : items(key).length;

  return (
    <div className="setup">
      <div className="obs-head">
        <div className="setup-head-titles">
          <h2 className="obs-title">Setup</h2>
          <p className="setup-dek">The artifacts your agents run with.</p>
        </div>
        <div className="setup-search">
          <span aria-hidden="true">🔎</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter your setup" aria-label="Filter setup" />
        </div>
        <ScopePicker apiBase={apiBase} scope={scope} onScope={setScope} />
      </div>

      <div className="console-tabs setup-tabs" role="tablist" aria-label="Setup" {...roving.containerProps}>
        {TABS.map((t, i) => (
          <button key={t.id} type="button" role="tab" aria-selected={i === tabIdx}
            className={"console-tab" + (i === tabIdx ? " is-active" : "")}
            {...roving.getTabProps(i)} onClick={() => go(i)}>
            {t.label}
            {t.key ? <span className="setup-tab-count">{count(t.key)}</span> : null}
          </button>
        ))}
      </div>

      {notFound ? (
        <p className="obs-muted setup-notfound">No artifact named “{openName}” in your setup.</p>
      ) : null}

      <div role="tabpanel">
        {tab.key ? (
          <TypeList items={items(tab.key).filter((a) => matches(a, listNeedle))} typeKey={tab.key} q={q} onOpen={openArtifact} />
        ) : listNeedle ? (
          <Results inv={inv} needle={listNeedle} q={q} onOpen={openArtifact} />
        ) : (
          <Overview inv={inv} onOpen={openArtifact} onTab={(key) => go(TABS.findIndex((t) => t.key === key))} />
        )}
      </div>

      {selected ? (
        // Keyed by artifact identity so switching artifacts (e.g. hash-driven, without closing
        // the modal) remounts the viewer instead of reusing it — otherwise its lazyBody/lazyErr
        // state from the previous artifact would survive into the new one's render.
        <ArtifactViewer key={selected.artifact.id ?? selected.artifact.name} apiBase={apiBase} sel={selected} onClose={closeViewer} />
      ) : null}
    </div>
  );
}

// The All landing: an editorial index — one summary card per type, a handful of names each.
function Overview({ inv, onOpen, onTab }:
  { inv: Inventory; onOpen: (k: TypeKey, n: string) => void; onTab: (k: TypeKey) => void }) {
  return (
    <div className="setup-overview">
      {TYPE_TABS.map((t) => {
        const all = (inv[t.key] as Artifact[]) ?? [];
        return (
          <section key={t.id} className="setup-card">
            <button type="button" className="setup-card-head" onClick={() => onTab(t.key)}>
              <span className="setup-dot" style={{ background: DOT[t.key] }} aria-hidden="true" />
              <span className="setup-card-label">{t.label}</span>
              <span className="setup-card-count">{all.length}</span>
            </button>
            {all.length === 0 ? (
              <p className="setup-card-empty">None found.</p>
            ) : (
              <ul className="setup-card-list">
                {all.slice(0, PREVIEW).map((a) => (
                  <li key={a.name}>
                    <button type="button" className="setup-card-item" onClick={() => onOpen(t.key, a.name)}>
                      <span className="setup-card-name">{a.name}</span>
                      {a.source ? <span className="setup-item-source">{a.source}</span> : null}
                      <LayerBadge a={a} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {all.length > PREVIEW ? (
              <button type="button" className="setup-card-more" onClick={() => onTab(t.key)}>
                View all {all.length} →
              </button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

// A focused type tab: the full list for one artifact type, filtered by the search box.
function TypeList({ items, typeKey, q, onOpen }:
  { items: Artifact[]; typeKey: TypeKey; q: string; onOpen: (k: TypeKey, n: string) => void }) {
  if (items.length === 0)
    return <p className="obs-muted setup-empty">{q.trim() ? `No artifacts match “${q}”.` : "None found."}</p>;
  return (
    <ul className="setup-list">
      {items.map((a) => <Row key={a.name} a={a} typeKey={typeKey} onOpen={onOpen} />)}
    </ul>
  );
}

// The All tab while filtering: cross-type matches, grouped by type under a small label.
function Results({ inv, needle, q, onOpen }:
  { inv: Inventory; needle: string; q: string; onOpen: (k: TypeKey, n: string) => void }) {
  const groups = TYPE_TABS
    .map((t) => ({ t, items: ((inv[t.key] as Artifact[]) ?? []).filter((a) => matches(a, needle)) }))
    .filter((g) => g.items.length > 0);
  if (groups.length === 0) return <p className="obs-muted setup-empty">No artifacts match “{q}”.</p>;
  return (
    <div className="setup-results">
      {groups.map(({ t, items }) => (
        <section key={t.id} className="setup-group">
          <p className="setup-results-label">{t.label}<span className="setup-count">{items.length}</span></p>
          <ul className="setup-list">
            {items.map((a) => <Row key={a.name} a={a} typeKey={t.key} onOpen={onOpen} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Row({ a, typeKey, onOpen }: { a: Artifact; typeKey: TypeKey; onOpen: (k: TypeKey, n: string) => void }) {
  return (
    <li>
      <button type="button" className="setup-item" onClick={() => onOpen(typeKey, a.name)}>
        <span className="setup-dot" style={{ background: DOT[typeKey] }} aria-hidden="true" />
        <span className="setup-item-body">
          <span className="setup-item-head">
            <span className="setup-item-name">{a.name}</span>
            {a.source ? <span className="setup-item-source">{a.source}</span> : null}
            <LayerBadge a={a} />
          </span>
          {a.description ? <span className="setup-item-desc">{a.description}</span> : null}
        </span>
      </button>
    </li>
  );
}

function ArtifactViewer({ apiBase, sel, onClose }: { apiBase: string; sel: { artifact: Artifact; group: string }; onClose: () => void }) {
  const a = sel.artifact;
  const { copied, copy } = useCopied();
  // The viewer is only ever open when the URL already reads #/setup/<tab>?a=<name>, so the
  // current href IS the shareable deep link — no need to reconstruct it.
  const copyLink = () => copy(window.location.href);
  const panelRef = useDialogA11y(onClose);

  const [lazyBody, setLazyBody] = useState<string | null>(null);
  const [lazyErr, setLazyErr] = useState<string | null>(null);
  useEffect(() => {
    // A project artifact ships its body inline (no entity path exists for project scope).
    if (a.content !== undefined || !a.id) return;
    let alive = true;
    artifactContentRoute.call(makeClient(apiBase), { query: { id: a.id } })
      .then((r) => { if (alive) { setLazyBody(r.content); setLazyErr(null); } })
      .catch((e: unknown) => { if (alive) setLazyErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [apiBase, a.id, a.content]);

  return (
    <div className="setup-modal" role="dialog" aria-modal="true" aria-label={a.name} onClick={onClose}>
      <div className="setup-modal-panel" ref={panelRef} onClick={(e) => e.stopPropagation()}>
        <div className="setup-modal-head">
          <div className="setup-modal-title">
            <strong>{a.name}</strong>
            {a.source ? <span className="setup-item-source">{a.source}</span> : null}
            <span className="obs-muted"> · {sel.group}</span>
          </div>
          <button type="button" className="setup-modal-copy" onClick={copyLink}>
            {copied ? "Copied ✓" : "Copy link"}
          </button>
          <button type="button" className="setup-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {a.description ? <p className="setup-modal-desc">{a.description}</p> : null}
        <div className="setup-modal-body">
          {/* Skills/subagents/instructions ship markdown content (inline for project artifacts,
              lazily fetched by id for global ones); MCP/hooks show their config. */}
          {(() => {
            const body = a.content ?? lazyBody ?? undefined;
            if (lazyErr) return <pre className="setup-config">Failed to load: {lazyErr}</pre>;
            if (body !== undefined) return <ContentView text={body} />;
            if (a.id) return <pre className="setup-config">Loading…</pre>;
            return <pre className="setup-config">{a.config ? JSON.stringify(a.config, null, 2) : "(no file body for this artifact)"}</pre>;
          })()}
        </div>
      </div>
    </div>
  );
}

export const setupPage = defineConsolePage({
  id: "setup", title: "Setup", icon: "🧩", order: 20, phase: "observe", category: "setup",
  group: "build", hiddenUntilUnlock: true,
  route: "#/setup", component: Setup,
});
