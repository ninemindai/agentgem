// src/pack/buildPack.ts
import type { ConfigInventory, Pack, PackArtifact } from "./types.js";

export interface ProjectSelection {
  skills?: string[];
  mcpServers?: string[];
  includeInstructions?: boolean;
}

export type PackSelection =
  | { all: true }
  | {
      all?: false;
      skills?: string[];
      mcpServers?: string[];
      includeInstructions?: boolean;
      projects?: Record<string, ProjectSelection>; // keyed by project root path
    };

export function buildPack(
  inventory: ConfigInventory,
  selection: PackSelection,
  opts: { name?: string; createdFrom?: string } = {},
): Pack {
  const artifacts: PackArtifact[] = [];
  const projects = inventory.projects ?? [];

  if ("all" in selection && selection.all) {
    artifacts.push(...inventory.skills, ...inventory.mcpServers, ...inventory.instructions);
    for (const p of projects) artifacts.push(...p.skills, ...p.mcpServers, ...p.instructions);
  } else {
    const sel = selection as Exclude<PackSelection, { all: true }>;
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
    for (const [root, ps] of Object.entries(sel.projects ?? {})) {
      const proj = projects.find((p) => p.root === root);
      if (!proj) throw new Error(`No project '${root}'. Loaded: ${projects.map((p) => p.root).join(", ") || "(none)"}`);
      for (const n of ps.skills ?? []) {
        const a = proj.skills.find((s) => s.name === n);
        if (!a) throw new Error(`No skill '${n}' in project '${proj.name}'. Available: ${proj.skills.map((s) => s.name).join(", ") || "(none)"}`);
        artifacts.push(a);
      }
      for (const n of ps.mcpServers ?? []) {
        const a = proj.mcpServers.find((s) => s.name === n);
        if (!a) throw new Error(`No MCP server '${n}' in project '${proj.name}'. Available: ${proj.mcpServers.map((s) => s.name).join(", ") || "(none)"}`);
        artifacts.push(a);
      }
      if (ps.includeInstructions) artifacts.push(...proj.instructions);
    }
  }

  return { name: opts.name ?? "pack", createdFrom: opts.createdFrom ?? "unknown", artifacts };
}
