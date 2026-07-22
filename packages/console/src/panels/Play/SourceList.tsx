// packages/console/src/panels/Play/SourceList.tsx
// Searchable, keyboard-navigable source list. The list is ALWAYS shown beneath the search box
// (never a closed dropdown) so the Composer's primary action — pick a source — stays discoverable.
// By default it shows a short, ranked shortlist (top `shortlist`, recent/most-relevant first) with a
// "Show all N" toggle; typing in the search filters the FULL set and ignores the cap.
import { useState } from "react";

interface Row { key?: string; main: string; meta?: string }

export function SourceList<T>({ items, filter, onPick, renderRow, placeholder, loadingLabel, rank, shortlist = 6 }: {
  items: T[] | null;                          // null = still loading
  filter: (item: T, q: string) => boolean;    // q is pre-lowercased + trimmed
  onPick: (item: T) => void;
  renderRow: (item: T) => Row;
  placeholder: string;
  loadingLabel: string;
  rank?: (a: T, b: T) => number;              // shortlist ordering (recent/most-used first); default = input order
  shortlist?: number;                         // how many to show collapsed (default 6)
}) {
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);            // highlighted index
  const [showAll, setShowAll] = useState(false);
  if (items == null) return <p className="play-intro">{loadingLabel}</p>;
  const needle = q.trim().toLowerCase();
  const ranked = rank ? [...items].sort(rank) : items;
  const matched = needle ? ranked.filter((it) => filter(it, needle)) : ranked;
  // Truncate to the shortlist only when browsing (no query) and not expanded. Searching always shows
  // every match — if you typed it, you want to find it, cap be damned.
  const capped = !needle && !showAll && matched.length > shortlist;
  const shown = capped ? matched.slice(0, shortlist) : matched;
  const hiIdx = Math.min(hi, Math.max(0, shown.length - 1));
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const it = shown[hiIdx]; if (it) onPick(it); }
    else if (e.key === "Escape") { setQ(""); setHi(0); }
  }
  const canExpand = !needle && matched.length > shortlist;
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
      {canExpand && (
        <button type="button" className="play-srclist__more" onClick={() => setShowAll((s) => !s)}>
          {showAll ? "Show fewer ▴" : `Show all ${matched.length} ▾`}
        </button>
      )}
    </div>
  );
}
