import type { Inventory, Usage } from "../../api/routes.js";

export interface LedgerItem { name: string; invocations: number }
export interface LedgerGroup { key: string; label: string; items: LedgerItem[] }

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
      items: (inv[key] ?? []).map((a) => ({ name: a.name, invocations: 0 })),
    }))
    .filter((g) => g.items.length > 0);
}

export function mergeUsage(groups: LedgerGroup[], usage: Usage): LedgerGroup[] {
  const typeOf = new Map(CATEGORIES.map((c) => [c.key, c.type]));
  return groups.map((g) => {
    const type = typeOf.get(g.key as InventoryCategory);
    const counts = new Map(
      usage.artifacts.filter((u) => u.type === type).map((u) => [u.name, u.invocations]),
    );
    return { ...g, items: g.items.map((i) => ({ ...i, invocations: counts.get(i.name) ?? 0 })) };
  });
}
