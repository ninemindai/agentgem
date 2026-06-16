// src/pack/buildPack.ts
import type { ConfigInventory, Pack, PackArtifact } from "./types.js";

export type PackSelection =
  | { all: true }
  | {
      all?: false;
      skills?: string[];
      mcpServers?: string[];
      includeInstructions?: boolean;
      projectSkills?: string[];
      projectMcpServers?: string[];
      includeProjectInstructions?: boolean;
    };

export function buildPack(
  inventory: ConfigInventory,
  selection: PackSelection,
  opts: { name?: string; createdFrom?: string } = {},
): Pack {
  const artifacts: PackArtifact[] = [];
  const project = inventory.project;

  if ("all" in selection && selection.all) {
    artifacts.push(...inventory.skills, ...inventory.mcpServers, ...inventory.instructions);
    if (project) artifacts.push(...project.skills, ...project.mcpServers, ...project.instructions);
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
    for (const n of sel.projectSkills ?? []) {
      const a = project?.skills.find((s) => s.name === n);
      if (!a) throw new Error(`No project skill '${n}'. Available: ${project?.skills.map((s) => s.name).join(", ") || "(none)"}`);
      artifacts.push(a);
    }
    for (const n of sel.projectMcpServers ?? []) {
      const a = project?.mcpServers.find((s) => s.name === n);
      if (!a) throw new Error(`No project MCP server '${n}'. Available: ${project?.mcpServers.map((s) => s.name).join(", ") || "(none)"}`);
      artifacts.push(a);
    }
    if (sel.includeProjectInstructions && project) artifacts.push(...project.instructions);
  }

  return { name: opts.name ?? "pack", createdFrom: opts.createdFrom ?? "unknown", artifacts };
}
