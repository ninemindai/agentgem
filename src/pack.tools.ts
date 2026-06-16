// src/pack.tools.ts
import { z } from "zod";
import { mcpServer, tool } from "@agentback/mcp";
import { introspectConfig } from "./pack/introspect.js";
import { buildPack } from "./pack/buildPack.js";
import { PackSelectionSchema } from "./schemas.js";
import { resolveDir } from "./resolveDir.js";

const InventoryInput = z.object({ dir: z.string().optional() });
const PackInput = z.object({ selection: PackSelectionSchema, name: z.string().optional(), dir: z.string().optional() });

@mcpServer()
export class PackTools {
  @tool("inventory", {
    description: "Introspect the local coding-agent config (skills, MCP servers, CLAUDE.md). Secrets are redacted.",
    input: InventoryInput,
  })
  async inventory(input: z.infer<typeof InventoryInput>) {
    return introspectConfig({ claudeDir: resolveDir(input.dir) });
  }

  @tool("pack", {
    description: "Build a redacted Pack from a selection of the introspected config artifacts.",
    input: PackInput,
  })
  async pack(input: z.infer<typeof PackInput>) {
    const dir = resolveDir(input.dir);
    return buildPack(introspectConfig({ claudeDir: dir }), input.selection, { name: input.name ?? "pack", createdFrom: dir });
  }
}
