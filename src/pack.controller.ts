// src/pack.controller.ts
import type { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { introspectConfig, introspectProject } from "./pack/introspect.js";
import { buildPack } from "./pack/buildPack.js";
import { scaffoldChecks } from "./pack/checks.js";
import { materialize, compatibility } from "./pack/targets.js";
import type { TargetId } from "./pack/targets.js";
import { renderManagedAgent } from "./pack/publish.js";
import { publishManagedAgent, anthropicPublishClient } from "./publish.js";
import type { ConfigInventory } from "./pack/types.js";
import {
  InventorySchema, PackSchema, PackRequestSchema, DirQuerySchema, PickQuerySchema, PickFolderSchema,
  ScaffoldChecksRequestSchema, ScaffoldChecksResponseSchema,
  MaterializeRequestSchema, MaterializeResponseSchema,
  PublishRequestSchema, PublishPreviewResponseSchema, PublishReadyResponseSchema, PublishResultSchema,
} from "./schemas.js";
import { resolveDirs, resolveProject } from "./resolveDir.js";
import { pickFolder } from "./pickFolder.js";

@api({ basePath: "/api" })
export class PackController {
  @get("/inventory", { query: DirQuerySchema, response: InventorySchema })
  async inventory(input: { query: z.infer<typeof DirQuerySchema> }): Promise<z.infer<typeof InventorySchema>> {
    return introspectAll(input.query.dir, parseProjectsQuery(input.query.projects));
  }

  @post("/pack", { body: PackRequestSchema, response: PackSchema })
  async pack(input: { body: z.infer<typeof PackRequestSchema> }): Promise<z.infer<typeof PackSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    return buildPack(inventory, input.body.selection, {
      name: input.body.name ?? "pack",
      createdFrom: dirs.claudeDir,
      checks: input.body.checks,
    });
  }

  @post("/scaffold-checks", { body: ScaffoldChecksRequestSchema, response: ScaffoldChecksResponseSchema })
  async scaffoldChecks(input: { body: z.infer<typeof ScaffoldChecksRequestSchema> }): Promise<z.infer<typeof ScaffoldChecksResponseSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const pack = buildPack(inventory, input.body.selection, { name: input.body.name ?? "pack", createdFrom: dirs.claudeDir });
    return { checks: scaffoldChecks(pack) };
  }

  @post("/materialize", { body: MaterializeRequestSchema, response: MaterializeResponseSchema })
  async materialize(input: { body: z.infer<typeof MaterializeRequestSchema> }): Promise<z.infer<typeof MaterializeResponseSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const pack = buildPack(inventory, input.body.selection, { name: input.body.name ?? "pack", createdFrom: dirs.claudeDir });
    const target = input.body.target as TargetId;
    return { target, ...materialize(pack, target), compatibility: compatibility(pack) };
  }

  // Offline render of the Managed Agents agent payload + skip/secret/skill lists. No network.
  @post("/publish-preview", { body: PublishRequestSchema, response: PublishPreviewResponseSchema })
  async publishPreview(input: { body: z.infer<typeof PublishRequestSchema> }): Promise<z.infer<typeof PublishPreviewResponseSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const pack = buildPack(inventory, input.body.selection, { name: input.body.name ?? "pack", createdFrom: dirs.claudeDir });
    const r = renderManagedAgent(pack);
    return { payload: r.payload, skillsToRegister: r.skillsToRegister.map((s) => s.name), skipped: r.skipped, vaultSecrets: r.vaultSecrets };
  }

  // Whether the server has an ANTHROPIC_API_KEY (the UI disables Publish without it). Boolean only.
  @get("/publish-ready", { query: PickQuerySchema, response: PublishReadyResponseSchema })
  async publishReady(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof PublishReadyResponseSchema>> {
    return { ready: !!process.env.ANTHROPIC_API_KEY };
  }

  // OUTWARD-FACING: creates a Managed Agent in the operator's Anthropic org. Gated on the
  // server-side key (the UI also gates via /publish-ready + an explicit confirm). The key is read
  // here and never returned to the client; only the redacted pack payload is sent to Anthropic.
  @post("/publish", { body: PublishRequestSchema, response: PublishResultSchema })
  async publish(input: { body: z.infer<typeof PublishRequestSchema> }): Promise<z.infer<typeof PublishResultSchema>> {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set on the server — cannot publish to Managed Agents.");
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const pack = buildPack(inventory, input.body.selection, { name: input.body.name ?? "pack", createdFrom: dirs.claudeDir });
    return publishManagedAgent(pack, anthropicPublishClient(key));
  }

  // Pop the OS-native folder picker and return the chosen absolute path (null if cancelled).
  @get("/pick-folder", { query: PickQuerySchema, response: PickFolderSchema })
  async pickFolder(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof PickFolderSchema>> {
    return { path: await pickFolder() };
  }
}

// Query params can't carry arrays cleanly, so `projects` arrives JSON-encoded.
function parseProjectsQuery(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Compose the global inventory with project sections. Each root is the user's explicit
// native-picker selection; we canonicalize to absolute paths and dedup.
function introspectAll(dir: string | undefined, projects: string[] | undefined): ConfigInventory {
  const inventory = introspectConfig(resolveDirs(dir));
  const roots = (projects ?? []).map(resolveProject).filter((r, i, a) => r.length > 0 && a.indexOf(r) === i);
  if (roots.length) inventory.projects = roots.map(introspectProject);
  return inventory;
}
