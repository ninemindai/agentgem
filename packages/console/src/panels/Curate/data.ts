import type { Inventory, Usage } from "../../api/routes.js";

export interface LedgerItem { name: string; invocations: number; lastUsedMs: number | null; detail?: string }
export interface LedgerGroup { key: string; label: string; items: LedgerItem[] }

export type SortKey = "uses" | "last";
export type SortDir = "desc" | "asc";
export interface LedgerView { query: string; sort: SortKey; dir: SortDir; usedOnly: boolean }
// Show every artifact type by default (MCP servers / instructions often have no
// recorded usage; the old `usedOnly` default silently hid those whole categories).
// "Used only" is now an opt-in focus filter. Collapsible groups keep the long
// Skills list manageable.
export const DEFAULT_VIEW: LedgerView = { query: "", sort: "uses", dir: "desc", usedOnly: false };

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
      items: (inv[key] ?? []).map((a) => ({
        name: a.name,
        invocations: 0,
        lastUsedMs: null,
        detail: a.content ?? (a.config ? JSON.stringify(a.config, null, 2) : undefined),
      })),
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

/** Compact relative time for a last-used timestamp; "" when unknown. */
export function relativeTime(ms: number | null, now: number = Date.now()): string {
  if (ms == null) return "";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

// Client-side search/sort/filter over the merged groups. Pure: same inputs ->
// same output. Empty groups (all items filtered out) are dropped.
export function applyView(groups: LedgerGroup[], view: LedgerView): LedgerGroup[] {
  const q = view.query.trim().toLowerCase();
  const dir = view.dir === "asc" ? -1 : 1;
  const cmp = view.sort === "last"
    ? (a: LedgerItem, b: LedgerItem) => dir * ((b.lastUsedMs ?? -1) - (a.lastUsedMs ?? -1))
    : (a: LedgerItem, b: LedgerItem) => dir * (b.invocations - a.invocations);
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
