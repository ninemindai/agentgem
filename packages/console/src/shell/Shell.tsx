import { useEffect, useState } from "react";
import { sortedPages, type ConsolePage } from "../registry.js";

export function Shell({ pages, apiBase }: { pages: ConsolePage[]; apiBase: string }) {
  const ordered = sortedPages(pages);
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const active = ordered.find((p) => p.route === hash) ?? ordered[0];

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
        {ordered.map((p) => (
          <button
            key={p.id}
            className={"console-nav-item" + (p === active ? " is-active" : "")}
            onClick={() => { window.location.hash = p.route; }}
          >
            {p.icon ? <span className="console-nav-icon">{p.icon}</span> : null}
            {p.title}
          </button>
        ))}
        <a className="console-legacy" href="/legacy">Classic UI ↗</a>
      </nav>
      <main className="console-main">{active?.component({ apiBase })}</main>
    </div>
  );
}
