import { useEffect, useState } from "react";
import { groupedPages, sortedPages, type ConsolePage } from "../registry.js";
import { ActiveGemSwitcher } from "./ActiveGemSwitcher.js";
import { useActiveGem } from "../activeGem.js";

export function Shell({ pages, apiBase }: { pages: ConsolePage[]; apiBase: string }) {
  const groups = groupedPages(pages);
  const ordered = sortedPages(pages);
  // Drives both the "Build · <gem>" subheader and the dimming of gem-scoped
  // build stages — one subscription so nav text and lock state never drift.
  const { keys, name } = useActiveGem();
  const hasGem = keys.size > 0;
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Exact match first; otherwise the longest route that is a prefix of the hash,
  // so a drill-down sub-route (e.g. #/inspect/<id>) still resolves to its page.
  const base = hash.split(/[?]/)[0];
  const active = ordered.find((p) => p.route === base)
    ?? [...ordered].filter((p) => base.startsWith(p.route + "/")).sort((a, b) => b.route.length - a.route.length)[0]
    ?? ordered[0];
  // Render the active page as a real element (not `active.component({...})`).
  // Calling it as a function inlines the page's hooks into Shell's own hook
  // list, so switching pages changes Shell's hook count and React throws
  // "rendered fewer hooks than expected". An element gives each page its own fiber.
  const ActivePage = active?.component;

  const item = (p: ConsolePage) => (
    <button
      key={p.id}
      className={"console-nav-item" + (p === active ? " is-active" : "") + (p.requiresGem && !hasGem ? " is-locked" : "")}
      onClick={() => { window.location.hash = p.route; }}
    >
      {p.icon ? <span className="console-nav-icon">{p.icon}</span> : null}
      {p.title}
    </button>
  );

  return (
    <div className="console">
      <nav className="console-nav">
        <div className="console-brand">
          <svg className="console-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 3h12l4 6-10 12L2 9l4-6Z" fill="currentColor" fillOpacity=".14" />
            <path d="M6 3h12l4 6-10 12L2 9l4-6Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="M2 9h20M9 3 7 9l5 12M15 3l2 6-5 12" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" opacity=".7" />
          </svg>
          AgentGem
        </div>
        <ActiveGemSwitcher apiBase={apiBase} />
        {groups.observe.length > 0 && <div className="console-group-label">Observe</div>}
        {groups.observe.map(item)}
        <div className="console-group-label">
          Build <span className="console-group-gem">· {name || "New Gem"}</span>
        </div>
        {groups.build.map(item)}
        {groups.library.length > 0 && <div className="console-group-label">Library</div>}
        {groups.library.map(item)}
        <div className="console-footer">{groups.settings.map(item)}</div>
      </nav>
      <main className="console-main">{ActivePage ? <ActivePage apiBase={apiBase} /> : null}</main>
    </div>
  );
}
