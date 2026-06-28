import type { Inventory, Usage } from "../../api/routes.js";

export interface LedgerItem { name: string; invocations: number; lastUsedMs: number | null }
export interface LedgerGroup { key: string; label: string; items: LedgerItem[] }

export type SortKey = "uses" | "last";
export interface LedgerView { query: string; sort: SortKey; usedOnly: boolean }
export const DEFAULT_VIEW: LedgerView = { query: "", sort: "uses", usedOnly: true };

type InventoryCategory = "skills" | "mcpServers" | "instructions" | "hooks";

/** Inventory category -> usage `type` + sidebar label, in display order. */
const CATEGORIES: { key: InventoryCategory; type: string; label: string }[] = [
  { key: "skills", type: "skill", label: "Skills" },
  { key: "mcpServers", type: "mcpServer", label: "MCP Servers" },
  { key: "instructions", type: "instructions", label: "Instructions" },
  { key: "hooks", type: "hook", label: "Hooks" },
];

export function groupInventory(inv: Inventory): LedgerGroup[] {
  return CATEGORIES
    .map(({ key, label }) => ({
      key,
      label,
      items: (inv[key] ?? []).map((a) => ({ name: a.name, invocations: 0, lastUsedMs: null })),
    }))
    .filter((g) => g.items.length > 0);
}

export function mergeUsage(groups: LedgerGroup[], usage: Usage): LedgerGroup[] {
  const typeOf = new Map(CATEGORIES.map((c) => [c.key, c.type]));
  return groups.map((g) => {
    const type = typeOf.get(g.key as InventoryCategory);
    const byName = new Map(usage.artifacts.filter((u) => u.type === type).map((u) => [u.name, u]));
    return {
      ...g,
      items: g.items.map((i) => {
        const u = byName.get(i.name);
        return { ...i, invocations: u?.invocations ?? 0, lastUsedMs: u?.lastUsedMs ?? null };
      }),
    };
  });
}

// Client-side search/sort/filter over the merged groups. Pure: same inputs ->
// same output. Empty groups (all items filtered out) are dropped.
export function applyView(groups: LedgerGroup[], view: LedgerView): LedgerGroup[] {
  const q = view.query.trim().toLowerCase();
  const cmp = view.sort === "last"
    ? (a: LedgerItem, b: LedgerItem) => (b.lastUsedMs ?? -1) - (a.lastUsedMs ?? -1)
    : (a: LedgerItem, b: LedgerItem) => b.invocations - a.invocations;
  return groups
    .map((g) => {
      const items = g.items
        .filter((i) => (q ? i.name.toLowerCase().includes(q) : true))
        .filter((i) => (view.usedOnly ? i.invocations > 0 : true))
        .slice()
        .sort(cmp);
      return { ...g, items };
    })
    .filter((g) => g.items.length > 0);
}
