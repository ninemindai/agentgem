// src/pack.controller.ts
import type { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { introspectConfig, introspectProject } from "./pack/introspect.js";
import { buildPack } from "./pack/buildPack.js";
import { scaffoldChecks } from "./pack/checks.js";
import { materialize, compatibility } from "./pack/targets.js";
import type { TargetId } from "./pack/targets.js";
import { DEPLOY_REGISTRY, deployTargetList } from "./pack/deploy.js";
import type { DeployTargetId } from "./pack/deploy.js";
import { createWorkspace, listWorkspaces, readWorkspace, renderTarget, deleteWorkspace } from "./pack/workspaces.js";
import { writePackArchive, readPackArchive } from "./pack/archive.js";
import type { PackLock } from "./pack/archive.js";
import { writeArchiveDir, readArchiveDir } from "./pack/archiveFs.js";
import { packTar } from "./pack/archiveTar.js";
import type { Pack } from "./pack/types.js";

import type { ConfigInventory } from "./pack/types.js";
import {
  InventorySchema, PackSchema, PackRequestSchema, DirQuerySchema, PickQuerySchema, PickFolderSchema,
  ScaffoldChecksRequestSchema, ScaffoldChecksResponseSchema,
  MaterializeRequestSchema, MaterializeResponseSchema,
  PublishPreviewRequestSchema, PublishRequestSchema, PublishPreviewResponseSchema, PublishReadyResponseSchema, PublishResultSchema,
  DeployTargetsResponseSchema, DeployReadyQuerySchema,
  ArchiveRequestSchema, ArchiveResponseSchema,
  CreateWorkspaceRequestSchema, WorkspaceQuerySchema, RenderRequestSchema, WorkspaceNameRequestSchema, WorkspaceSummarySchema, WorkspaceDetailSchema, RenderResultSchema, ListWorkspacesResponseSchema, DeleteWorkspaceResponseSchema,
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
    const target = input.body.target as TargetId;
    let pack: Pack;
    if (input.body.archivePath) {
      pack = readPackArchive(readArchiveDir(input.body.archivePath));
    } else {
      const dirs = resolveDirs(input.body.dir);
      const inventory = introspectAll(input.body.dir, input.body.projects);
      pack = buildPack(inventory, input.body.selection!, { name: input.body.name ?? "pack", createdFrom: dirs.claudeDir });
    }
    return { target, ...materialize(pack, target), compatibility: compatibility(pack) };
  }

  @post("/archive", { body: ArchiveRequestSchema, response: ArchiveResponseSchema })
  async archive(input: { body: z.infer<typeof ArchiveRequestSchema> }): Promise<z.infer<typeof ArchiveResponseSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const pack = buildPack(inventory, input.body.selection, { name: input.body.name ?? "pack", createdFrom: dirs.claudeDir });
    const { files, skipped } = writePackArchive(pack, { version: input.body.version });
    const lock = JSON.parse(files["pack.lock"]) as PackLock;
    let path: string | null = null;
    if (input.body.outDir) { writeArchiveDir(input.body.outDir, files); path = input.body.outDir; }
    const tarGz = input.body.tar ? packTar(files).toString("base64") : null;
    return { files, lock, skipped, path, tarGz };
  }

  @post("/workspaces", { body: CreateWorkspaceRequestSchema, response: WorkspaceSummarySchema })
  async createWorkspace(input: { body: z.infer<typeof CreateWorkspaceRequestSchema> }): Promise<z.infer<typeof WorkspaceSummarySchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const pack = buildPack(inventory, input.body.selection, { name: input.body.name, createdFrom: dirs.claudeDir });
    return createWorkspace(input.body.name, pack, { version: input.body.version });
  }

  @get("/workspaces", { query: PickQuerySchema, response: ListWorkspacesResponseSchema })
  async listWorkspaces(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof ListWorkspacesResponseSchema>> {
    return { workspaces: listWorkspaces() };
  }

  @get("/workspace", { query: WorkspaceQuerySchema, response: WorkspaceDetailSchema })
  async readWorkspace(input: { query: z.infer<typeof WorkspaceQuerySchema> }): Promise<z.infer<typeof WorkspaceDetailSchema>> {
    return readWorkspace(input.query.name);
  }

  @post("/workspace/render", { body: RenderRequestSchema, response: RenderResultSchema })
  async renderWorkspace(input: { body: z.infer<typeof RenderRequestSchema> }): Promise<z.infer<typeof RenderResultSchema>> {
    return renderTarget(input.body.name, input.body.target as TargetId);
  }

  @post("/workspace/delete", { body: WorkspaceNameRequestSchema, response: DeleteWorkspaceResponseSchema })
  async deleteWorkspace(input: { body: z.infer<typeof WorkspaceNameRequestSchema> }): Promise<z.infer<typeof DeleteWorkspaceResponseSchema>> {
    deleteWorkspace(input.body.name);
    return { deleted: input.body.name };
  }

  @get("/deploy-targets", { query: PickQuerySchema, response: DeployTargetsResponseSchema })
  async deployTargets(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof DeployTargetsResponseSchema>> {
    return { targets: deployTargetList() };
  }

  // Offline render of the deploy payload + skip/secret/skill lists. No network.
  @post("/publish-preview", { body: PublishPreviewRequestSchema, response: PublishPreviewResponseSchema })
  async publishPreview(input: { body: z.infer<typeof PublishPreviewRequestSchema> }): Promise<z.infer<typeof PublishPreviewResponseSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const pack = buildPack(inventory, input.body.selection, { name: input.body.name ?? "pack", createdFrom: dirs.claudeDir });
    const target = (input.body.target ?? "claude-managed") as DeployTargetId;
    const r = DEPLOY_REGISTRY[target].preview(pack);
    return { payload: r.payload, skillsToRegister: r.skillsToRegister.map((s) => s.name), skipped: r.skipped, vaultSecrets: r.vaultSecrets };
  }

  // Whether the server is configured for the deploy backend (the UI gates on this). Boolean only.
  @get("/publish-ready", { query: DeployReadyQuerySchema, response: PublishReadyResponseSchema })
  async publishReady(input: { query: z.infer<typeof DeployReadyQuerySchema> }): Promise<z.infer<typeof PublishReadyResponseSchema>> {
    const target = (input.query.target ?? "claude-managed") as DeployTargetId;
    return { ready: DEPLOY_REGISTRY[target].ready() };
  }

  // OUTWARD-FACING: gated network deploy through the selected backend. The key is read server-side
  // (inside the registry's deploy) and never returned; only the redacted pack payload is sent.
  @post("/publish", { body: PublishRequestSchema, response: PublishResultSchema })
  async publish(input: { body: z.infer<typeof PublishRequestSchema> }): Promise<z.infer<typeof PublishResultSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const pack = buildPack(inventory, input.body.selection, { name: input.body.name ?? "pack", createdFrom: dirs.claudeDir });
    const target = (input.body.target ?? "claude-managed") as DeployTargetId;
    return DEPLOY_REGISTRY[target].deploy(pack, input.body.requestId);
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
