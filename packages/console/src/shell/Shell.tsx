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
        <div className="console-brand">AgentGem</div>
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
      </nav>
      <main className="console-main">{active?.component({ apiBase })}</main>
    </div>
  );
}
