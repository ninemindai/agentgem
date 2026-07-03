// packages/console/src/shell/SortTh.tsx
// A sortable <th> for obs-tables: renders the column caption as a button that
// drives useTableSort, with a caret showing the active direction. Pairs with
// useTableSort — see Optimize ▸ Prune.
import type { ReactNode } from "react";
import type { SortDir } from "./useTableSort.js";

export function SortTh({ label, dir, onClick, className }: {
  label: ReactNode;
  dir: SortDir | null;   // active direction for THIS column, or null when it isn't the sort key
  onClick: () => void;
  className?: string;
}) {
  return (
    <th className={className} aria-sort={dir ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={"sort-th" + (dir ? " is-sorted" : "")} onClick={onClick}>
        <span>{label}</span>
        <span className="sort-caret" aria-hidden="true">{dir === "asc" ? "▲" : dir === "desc" ? "▼" : "↕"}</span>
      </button>
    </th>
  );
}
