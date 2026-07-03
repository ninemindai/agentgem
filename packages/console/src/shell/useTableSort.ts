// packages/console/src/shell/useTableSort.ts
// Click-to-sort mechanics for the console's obs-tables. Each sortable column
// supplies a comparison value; the hook tracks which column is active and in
// which direction. Clicking a header cycles a 3-state loop:
//   source order → column's default direction → opposite → source order.
// The "source order" state (active === null) leaves rows untouched, which is how
// the Prune table keeps its server-provided "recommended" order reachable.
import { useMemo, useState } from "react";

export type SortDir = "asc" | "desc";

export interface SortColumn<T> {
  id: string;
  // Comparison value for a row. Coerce nulls here (e.g. `a.lastUsedMs ?? 0`) so
  // the comparator stays dumb. Numbers compare numerically, everything else by
  // locale-aware string compare.
  value: (item: T) => number | string;
  // Direction applied on the first click (default "asc"). Set "desc" for columns
  // where "biggest first" is the useful default (e.g. est. context).
  defaultDir?: SortDir;
}

function cmp(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

export function useTableSort<T>(columns: SortColumn<T>[]) {
  const [active, setActive] = useState<{ id: string; dir: SortDir } | null>(null);
  const byId = useMemo(() => new Map(columns.map((c) => [c.id, c] as const)), [columns]);

  const onSort = (id: string) => setActive((prev) => {
    const col = byId.get(id);
    if (!col) return prev;
    const def = col.defaultDir ?? "asc";
    if (!prev || prev.id !== id) return { id, dir: def };            // activate
    if (prev.dir === def) return { id, dir: def === "asc" ? "desc" : "asc" }; // flip
    return null;                                                     // back to source order
  });

  const dirFor = (id: string): SortDir | null => (active?.id === id ? active.dir : null);

  const sort = (rows: T[]): T[] => {
    if (!active) return rows;
    const col = byId.get(active.id);
    if (!col) return rows;
    const mul = active.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => cmp(col.value(a), col.value(b)) * mul);
  };

  return { active, onSort, dirFor, sort };
}
