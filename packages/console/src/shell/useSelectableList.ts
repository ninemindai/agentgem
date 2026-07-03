// packages/console/src/shell/useSelectableList.ts
// Shared list mechanics for the console's selectable tables (Optimize ▸ Prune,
// Optimize ▸ Discover, …): a text filter, per-row selection, and a select-all
// that operates on the eligible, currently-visible rows. Each list keeps its own
// columns and row rendering; only the filter/selection logic is shared here.
import { useMemo, useState } from "react";

export interface SelectableListOptions<T> {
  keyOf: (item: T) => string;
  // Which rows can be selected (default: all). Non-eligible rows render no checkbox
  // and are never picked up by select-all.
  eligible?: (item: T) => boolean;
  // Text-filter predicate against the lower-cased query (default: no text filtering).
  matches?: (item: T, q: string) => boolean;
  // A non-text filter applied on top of the query (e.g. a "prunable only" toggle).
  extraFilter?: (item: T) => boolean;
}

export function useSelectableList<T>(items: T[], opts: SelectableListOptions<T>) {
  const { keyOf, eligible = () => true, matches, extraFilter } = opts;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => items.filter((it) => (!extraFilter || extraFilter(it)) && (q === "" || !matches || matches(it, q))),
    [items, q, matches, extraFilter],
  );
  const eligibleVisible = useMemo(() => filtered.filter(eligible), [filtered, eligible]);
  const allSelected = eligibleVisible.length > 0 && eligibleVisible.every((it) => selected.has(keyOf(it)));

  const isSelected = (it: T) => selected.has(keyOf(it));
  const toggle = (it: T) => setSelected((prev) => {
    const next = new Set(prev);
    const k = keyOf(it);
    next.has(k) ? next.delete(k) : next.add(k);
    return next;
  });
  const toggleAll = () => setSelected((prev) => {
    const next = new Set(prev);
    for (const it of eligibleVisible) allSelected ? next.delete(keyOf(it)) : next.add(keyOf(it));
    return next;
  });
  const clear = () => setSelected(new Set());
  const selectedItems = () => items.filter((it) => selected.has(keyOf(it)));

  return {
    query, setQuery,
    filtered, eligibleVisible,
    selected, isSelected, selectedItems,
    toggle, toggleAll, allSelected, clear,
  };
}
