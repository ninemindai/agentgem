// src/pack/buildPack.ts
import type { ConfigInventory, Pack, PackArtifact } from "./types.js";

export type PackSelection =
  | { all: true }
  | { all?: false; skills?: string[]; mcpServers?: string[]; includeInstructions?: boolean };

export function buildPack(
  inventory: ConfigInventory,
  selection: PackSelection,
  opts: { name?: string; createdFrom?: string } = {},
): Pack {
  const artifacts: PackArtifact[] = [];

  if ("all" in selection && selection.all) {
    artifacts.push(...inventory.skills, ...inventory.mcpServers, ...inventory.instructions);
  } else {
    const sel = selection as { skills?: string[]; mcpServers?: string[]; includeInstructions?: boolean };
    for (const n of sel.skills ?? []) {
      const a = inventory.skills.find((s) => s.name === n);
      if (!a) throw new Error(`No skill '${n}'. Available: ${inventory.skills.map((s) => s.name).join(", ") || "(none)"}`);
      artifacts.push(a);
    }
    for (const n of sel.mcpServers ?? []) {
      const a = inventory.mcpServers.find((s) => s.name === n);
      if (!a) throw new Error(`No MCP server '${n}'. Available: ${inventory.mcpServers.map((s) => s.name).join(", ") || "(none)"}`);
      artifacts.push(a);
    }
    if (sel.includeInstructions) artifacts.push(...inventory.instructions);
  }

  return { name: opts.name ?? "pack", createdFrom: opts.createdFrom ?? "unknown", artifacts };
}
