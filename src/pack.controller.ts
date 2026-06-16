// src/pack.controller.ts
import type { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { introspectConfig, introspectProject } from "./pack/introspect.js";
import { buildPack } from "./pack/buildPack.js";
import type { ConfigInventory } from "./pack/types.js";
import { InventorySchema, PackSchema, PackRequestSchema, DirQuerySchema, BrowseQuerySchema, BrowseSchema } from "./schemas.js";
import { resolveDirs, resolveUnderHome } from "./resolveDir.js";
import { browseDir } from "./browse.js";

@api({ basePath: "/api" })
export class PackController {
  @get("/inventory", { query: DirQuerySchema, response: InventorySchema })
  async inventory(input: { query: z.infer<typeof DirQuerySchema> }): Promise<z.infer<typeof InventorySchema>> {
    return introspectAll(input.query.dir, input.query.project);
  }

  @post("/pack", { body: PackRequestSchema, response: PackSchema })
  async pack(input: { body: z.infer<typeof PackRequestSchema> }): Promise<z.infer<typeof PackSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.project);
    return buildPack(inventory, input.body.selection, { name: input.body.name ?? "pack", createdFrom: dirs.claudeDir });
  }

  // Server-backed folder browser for picking a project root. Lists subdirectory names only,
  // clamped to within the user's home dir (see resolveUnderHome / browseDir).
  @get("/browse", { query: BrowseQuerySchema, response: BrowseSchema })
  async browse(input: { query: z.infer<typeof BrowseQuerySchema> }): Promise<z.infer<typeof BrowseSchema>> {
    return browseDir(input.query.path);
  }
}

// Compose the global inventory with an optional project section (project root validated under home).
function introspectAll(dir: string | undefined, project: string | undefined): ConfigInventory {
  const inventory = introspectConfig(resolveDirs(dir));
  if (project && project.length > 0) inventory.project = introspectProject(resolveUnderHome(project));
  return inventory;
}
