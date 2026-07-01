import type { LedgerGroup } from "./data.js";

/** A selection entry keys an item by its group + name (names can repeat across groups). */
export const selKey = (groupKey: string, name: string): string => `${groupKey}::${name}`;

export interface GemSelection {
  skills?: string[];
  mcpServers?: string[];
  includeInstructions?: boolean;   // back-compat: all instructions
  instructions?: string[];         // the specific instructions selected
  hooks?: string[];
}

/** Map a recommendation artifact `type` to the Ledger group key. */
const GROUP_OF: Record<string, string> = {
  skill: "skills",
  mcp_server: "mcpServers",
  instructions: "instructions",
  hook: "hooks",
};

/** Selection keys for an analyze recommendation's `include` list (channels skipped). */
export function includeToKeys(include: { type: string; name: string }[]): string[] {
  return include
    .map((i) => (GROUP_OF[i.type] ? selKey(GROUP_OF[i.type], i.name) : null))
    .filter((k): k is string => k !== null);
}

/** All selectable keys across the (already filtered) visible groups. */
export function visibleKeys(groups: LedgerGroup[]): string[] {
  return groups.flatMap((g) => g.items.map((i) => selKey(g.key, i.name)));
}

/**
 * Translate the set of selected keys into the API selection object. Each group is
 * resolved by name — including instructions, so sharing a single lesson bundles
 * only that lesson, not every instruction on the machine.
 */
export function buildSelection(keys: Set<string>): GemSelection {
  const byGroup: Record<string, string[]> = {};
  for (const k of keys) {
    const i = k.indexOf("::");
    if (i < 0) continue;
    const g = k.slice(0, i);
    (byGroup[g] ??= []).push(k.slice(i + 2));
  }
  const sel: GemSelection = {};
  if (byGroup.skills?.length) sel.skills = byGroup.skills;
  if (byGroup.mcpServers?.length) sel.mcpServers = byGroup.mcpServers;
  if (byGroup.hooks?.length) sel.hooks = byGroup.hooks;
  if (byGroup.instructions?.length) sel.instructions = byGroup.instructions;
  return sel;
}
