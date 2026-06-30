import { useState } from "react";
import { listGems, filterGems } from "../gems/catalog";
import { kindLabel } from "../data";

export function Gems() {
  const [search, setSearch] = useState("");
  const gems = listGems();
  const visible = filterGems(gems, search);

  return (
    <div className="ex-gems">
      <input className="ex-search" type="search" aria-label="search gems"
        placeholder="filter gems by name, tag, description…" value={search}
        onChange={(e) => setSearch(e.target.value)} />
      {visible.length === 0 && <p className="ex-empty">No gems match "{search}".</p>}
      <ul className="ex-gem-list">
        {visible.map((g) => (
          <li key={g.key}>
            <a className="ex-gem-card" href={"/gems/" + encodeURIComponent(g.key)}>
              <span className="ex-gem-head">
                <span className="ex-gem-key">{g.key}</span>
                <span className="ex-gem-kinds">{g.artifactKinds.map((k) => <span key={k} className="ex-chip">{kindLabel(k)}</span>)}</span>
              </span>
              <span className="ex-gem-desc">{g.description}</span>
              <span className="ex-gem-tags">{g.tags.map((t) => <span key={t} className="ex-tag">#{t}</span>)}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
