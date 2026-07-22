// packages/console/src/panels/Play/SourceList.tsx
// Searchable, keyboard-navigable source list. The list is ALWAYS shown beneath the search box
// (never a closed dropdown) so the Composer's primary action — pick a source — stays discoverable.
import { useState } from "react";

interface Row { key?: string; main: string; meta?: string }

export function SourceList<T>({ items, filter, onPick, renderRow, placeholder, loadingLabel }: {
  items: T[] | null;                          // null = still loading
  filter: (item: T, q: string) => boolean;    // q is pre-lowercased + trimmed
  onPick: (item: T) => void;
  renderRow: (item: T) => Row;
  placeholder: string;
  loadingLabel: string;
}) {
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);            // highlighted index
  if (items == null) return <p className="play-intro">{loadingLabel}</p>;
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((it) => filter(it, needle)) : items;
  const hiIdx = Math.min(hi, Math.max(0, shown.length - 1));
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const it = shown[hiIdx]; if (it) onPick(it); }
    else if (e.key === "Escape") { setQ(""); setHi(0); }
  }
  return (
    <div className="play-srclist">
      <input className="play-input play-srclist__search" placeholder={placeholder} value={q}
        onChange={(e) => { setQ(e.target.value); setHi(0); }} onKeyDown={onKeyDown} aria-label={placeholder} />
      {shown.length === 0 ? <p className="play-srclist__empty">No matches</p> : (
        <ul className="play-src" role="listbox">
          {shown.map((it, i) => {
            const row = renderRow(it);
            return (
              <li key={row.key ?? row.main} role="option" aria-selected={i === hiIdx}
                className={`play-src-row${i === hiIdx ? " is-hi" : ""}`} onClick={() => onPick(it)}>
                <span className="play-src-row__main">{row.main}</span>
                {row.meta && <span className="play-src-row__meta">{row.meta}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
