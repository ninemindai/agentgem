// packages/console/src/shell/ListControls.tsx
// The shared control strip above a selectable list: a text filter, an optional
// slot for list-specific toggles (`extras`), a select-all/deselect-all button,
// and a slot for the batch action + summary (`actions`). Pairs with
// useSelectableList — see Optimize ▸ Prune and Optimize ▸ Discover.
import type { ReactNode } from "react";

export function ListControls({
  query, onQuery, label, placeholder,
  selectLabel, onSelectAll, selectDisabled = false,
  extras, actions,
}: {
  query: string;
  onQuery: (v: string) => void;
  label: string;                 // accessible name for the filter input
  placeholder?: string;
  selectLabel: string;           // e.g. "Select all (3)" / "Deselect all"
  onSelectAll: () => void;
  selectDisabled?: boolean;
  extras?: ReactNode;            // list-specific toggles (e.g. "prunable only")
  actions?: ReactNode;          // batch button + summary/note
}) {
  return (
    <div className="list-controls">
      <input
        className="list-filter" type="search" value={query} aria-label={label}
        placeholder={placeholder} onChange={(e) => onQuery(e.target.value)}
      />
      {extras}
      <button className="obs-range-btn" onClick={onSelectAll} disabled={selectDisabled}>{selectLabel}</button>
      {actions}
    </div>
  );
}
