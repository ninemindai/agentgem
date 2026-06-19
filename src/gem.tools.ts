// src/pack.tools.ts
import { z } from "zod";
import { mcpServer, tool } from "@agentback/mcp";
import { introspectConfig, introspectProject } from "./gem/introspect.js";
import { buildGem } from "./gem/buildGem.js";
import type { ConfigInventory } from "./gem/types.js";
import { GemSelectionSchema } from "./schemas.js";
import { resolveDirs, resolveProject } from "./resolveDir.js";

const InventoryInput = z.object({ dir: z.string().optional(), projects: z.array(z.string()).optional() });
const GemInput = z.object({ selection: GemSelectionSchema, name: z.string().optional(), dir: z.string().optional(), projects: z.array(z.string()).optional() });

function introspectAll(dir?: string, projects?: string[]): ConfigInventory {
  const inventory = introspectConfig(resolveDirs(dir));
  const roots = (projects ?? []).map(resolveProject).filter((r, i, a) => r.length > 0 && a.indexOf(r) === i);
  if (roots.length) inventory.projects = roots.map(introspectProject);
  return inventory;
}

@mcpServer()
export class GemTools {
  @tool("inventory", {
    description: "Introspect the local coding-agent config (skills, MCP servers, CLAUDE.md). Pass project roots to also include project-level artifacts. Secrets are redacted.",
    input: InventoryInput,
  })
  async inventory(input: z.infer<typeof InventoryInput>) {
    return introspectAll(input.dir, input.projects);
  }

  @tool("pack", {
    description: "Build a redacted Gem from a selection of the introspected config artifacts.",
    input: GemInput,
  })
  async pack(input: z.infer<typeof GemInput>) {
    const dirs = resolveDirs(input.dir);
    return buildGem(introspectAll(input.dir, input.projects), input.selection, { name: input.name ?? "pack", createdFrom: dirs.claudeDir });
  }
}
