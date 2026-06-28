import type { LedgerGroup } from "./data.js";

/** A selection entry keys an item by its group + name (names can repeat across groups). */
export const selKey = (groupKey: string, name: string): string => `${groupKey}::${name}`;

export interface GemSelection {
  skills?: string[];
  mcpServers?: string[];
  includeInstructions?: boolean;
  hooks?: string[];
}

/** All selectable keys across the (already filtered) visible groups. */
export function visibleKeys(groups: LedgerGroup[]): string[] {
  return groups.flatMap((g) => g.items.map((i) => selKey(g.key, i.name)));
}

/**
 * Translate the set of selected keys into the API selection object. Instructions
 * are all-or-nothing on the server (`includeInstructions`), so selecting any
 * instruction sets the flag.
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
  if (byGroup.instructions?.length) sel.includeInstructions = true;
  return sel;
}
