// src/pack.controller.ts
import type { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { introspectConfig, introspectProject } from "./pack/introspect.js";
import { buildPack } from "./pack/buildPack.js";
import type { ConfigInventory } from "./pack/types.js";
import { InventorySchema, PackSchema, PackRequestSchema, DirQuerySchema, PickQuerySchema, PickFolderSchema } from "./schemas.js";
import { resolveDirs, resolveProject } from "./resolveDir.js";
import { pickFolder } from "./pickFolder.js";

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

  // Pop the OS-native folder picker and return the chosen absolute path (null if cancelled).
  @get("/pick-folder", { query: PickQuerySchema, response: PickFolderSchema })
  async pickFolder(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof PickFolderSchema>> {
    return { path: await pickFolder() };
  }
}

// Compose the global inventory with an optional project section. The project root is the
// user's explicit native-picker selection; we only canonicalize it to an absolute path.
function introspectAll(dir: string | undefined, project: string | undefined): ConfigInventory {
  const inventory = introspectConfig(resolveDirs(dir));
  if (project && project.length > 0) inventory.project = introspectProject(resolveProject(project));
  return inventory;
}
