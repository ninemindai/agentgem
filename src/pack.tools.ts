// src/pack.tools.ts
import { z } from "zod";
import { mcpServer, tool } from "@agentback/mcp";
import { introspectConfig, introspectProject } from "./pack/introspect.js";
import { buildPack } from "./pack/buildPack.js";
import type { ConfigInventory } from "./pack/types.js";
import { PackSelectionSchema } from "./schemas.js";
import { resolveDirs, resolveUnderHome } from "./resolveDir.js";

const InventoryInput = z.object({ dir: z.string().optional(), project: z.string().optional() });
const PackInput = z.object({ selection: PackSelectionSchema, name: z.string().optional(), dir: z.string().optional(), project: z.string().optional() });

function introspectAll(dir?: string, project?: string): ConfigInventory {
  const inventory = introspectConfig(resolveDirs(dir));
  if (project && project.length > 0) inventory.project = introspectProject(resolveUnderHome(project));
  return inventory;
}

@mcpServer()
export class PackTools {
  @tool("inventory", {
    description: "Introspect the local coding-agent config (skills, MCP servers, CLAUDE.md). Pass a project root to also include project-level artifacts. Secrets are redacted.",
    input: InventoryInput,
  })
  async inventory(input: z.infer<typeof InventoryInput>) {
    return introspectAll(input.dir, input.project);
  }

  @tool("pack", {
    description: "Build a redacted Pack from a selection of the introspected config artifacts.",
    input: PackInput,
  })
  async pack(input: z.infer<typeof PackInput>) {
    const dirs = resolveDirs(input.dir);
    return buildPack(introspectAll(input.dir, input.project), input.selection, { name: input.name ?? "pack", createdFrom: dirs.claudeDir });
  }
}
