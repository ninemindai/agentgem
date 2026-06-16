// src/pack.controller.ts
import type { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { introspectConfig } from "./pack/introspect.js";
import { buildPack } from "./pack/buildPack.js";
import { InventorySchema, PackSchema, PackRequestSchema, DirQuerySchema } from "./schemas.js";
import { resolveDir } from "./resolveDir.js";

@api({ basePath: "/api" })
export class PackController {
  @get("/inventory", { query: DirQuerySchema, response: InventorySchema })
  async inventory(input: { query: z.infer<typeof DirQuerySchema> }): Promise<z.infer<typeof InventorySchema>> {
    return introspectConfig({ claudeDir: resolveDir(input.query.dir) });
  }

  @post("/pack", { body: PackRequestSchema, response: PackSchema })
  async pack(input: { body: z.infer<typeof PackRequestSchema> }): Promise<z.infer<typeof PackSchema>> {
    const dir = resolveDir(input.body.dir);
    const inventory = introspectConfig({ claudeDir: dir });
    return buildPack(inventory, input.body.selection, { name: input.body.name ?? "pack", createdFrom: dir });
  }
}
