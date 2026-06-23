// src/gem.controller.ts
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { introspectConfig, introspectProject } from "./gem/introspect.js";
import { buildGem } from "./gem/buildGem.js";
import { scaffoldChecks } from "./gem/checks.js";
import { materialize, compatibility } from "./gem/targets.js";
import type { TargetId } from "./gem/targets.js";
import { DEPLOY_REGISTRY, deployTargetList } from "./gem/deploy.js";
import type { DeployTargetId } from "./gem/deploy.js";
import { createWorkspace, listWorkspaces, readWorkspace, renderTarget, deleteWorkspace } from "./gem/workspaces.js";
import { writeGemArchive, readGemArchive } from "./gem/archive.js";
import type { GemLock } from "./gem/archive.js";
import { writeArchiveDir, readArchiveDir } from "./gem/archiveFs.js";
import { packTar } from "./gem/archiveTar.js";
import type { Gem } from "./gem/types.js";

import type { ConfigInventory } from "./gem/types.js";
import {
  InventorySchema, GemSchema, GemRequestSchema, DirQuerySchema, PickQuerySchema, PickFolderSchema,
  ScaffoldChecksRequestSchema, ScaffoldChecksResponseSchema,
  MaterializeRequestSchema, MaterializeResponseSchema,
  PublishPreviewRequestSchema, PublishRequestSchema, PublishPreviewResponseSchema, PublishReadyResponseSchema, PublishResultSchema,
  DeployTargetsResponseSchema, DeployReadyQuerySchema,
  ArchiveRequestSchema, ArchiveResponseSchema,
  CreateWorkspaceRequestSchema, WorkspaceQuerySchema, RenderRequestSchema, WorkspaceNameRequestSchema, WorkspaceSummarySchema, WorkspaceDetailSchema, RenderResultSchema, ListWorkspacesResponseSchema, DeleteWorkspaceResponseSchema,
  RunReadyQuerySchema, RunReadyResponseSchema, RunRequestSchema, RunStatusQuerySchema, RunStateSchema, RunStopRequestSchema, RunStopResponseSchema,
  CredentialRequestSchema, CredentialResponseSchema,
  TestbedDetectQuerySchema, TestbedDetectResponseSchema,
  TestbedSuggestionQuerySchema, TestbedSuggestionResponseSchema,
  TestbedRecentsResponseSchema,
  TestbedProjectsQuerySchema, TestbedProjectsResponseSchema,
  TestbedScaffoldRequestSchema, TestbedScaffoldResponseSchema,
  TestbedImportRequestSchema, TestbedImportResponseSchema,
  AgentcoreReadyResponseSchema, AgentcoreDeployRequestSchema, AgentcoreStatusQuerySchema, AgentcoreDeployStateSchema,
  RegistryReadyResponseSchema, RegistryIndexResponseSchema,
  RegistryResolveRequestSchema, RegistryResolveResponseSchema,
  RegistryInstallRequestSchema, RegistryInstallResponseSchema,
  RegistryPublishRequestSchema, RegistryPublishResponseSchema,
} from "./schemas.js";
import { runReadiness, startLocal, stopLocal, getRunStatus, deployVercel, deployCloudflare } from "./gem/run.js";
import { setCredential } from "./gem/credentials.js";
import { agentcoreReadiness, deployAgentcore, getAgentcoreStatus } from "./gem/agentcoreRun.js";
import { scaffoldTestbed, importArtifacts } from "./gem/testbed.js";
import { detectFlavor, suggestTestbed, discoverProjects } from "./gem/testbedFlavors.js";
import type { TestbedFlavorId } from "./gem/testbedFlavors.js";
import { readRecents, upsertRecent } from "./gem/recents.js";
import { resolveInstall, publishGem } from "./gem/registry.js";
import { githubRegistrySource, githubRegistryPublisher, registryConfigFromEnv, registryReady } from "./gem/registryGithub.js";
import { resolveDirs, resolveProject, agentgemHome } from "./resolveDir.js";
import { pickFolder } from "./pickFolder.js";

@api({ basePath: "/api" })
export class GemController {
  @get("/inventory", { query: DirQuerySchema, response: InventorySchema })
  async inventory(input: { query: z.infer<typeof DirQuerySchema> }): Promise<z.infer<typeof InventorySchema>> {
    return introspectAll(input.query.dir, parseProjectsQuery(input.query.projects));
  }

  @post("/gem", { body: GemRequestSchema, response: GemSchema })
  async gem(input: { body: z.infer<typeof GemRequestSchema> }): Promise<z.infer<typeof GemSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    return buildGem(inventory, input.body.selection, {
      name: input.body.name ?? "gem",
      createdFrom: dirs.claudeDir,
      checks: input.body.checks,
    });
  }

  @post("/scaffold-checks", { body: ScaffoldChecksRequestSchema, response: ScaffoldChecksResponseSchema })
  async scaffoldChecks(input: { body: z.infer<typeof ScaffoldChecksRequestSchema> }): Promise<z.infer<typeof ScaffoldChecksResponseSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const gem = buildGem(inventory, input.body.selection, { name: input.body.name ?? "gem", createdFrom: dirs.claudeDir });
    return { checks: scaffoldChecks(gem) };
  }

  @post("/materialize", { body: MaterializeRequestSchema, response: MaterializeResponseSchema })
  async materialize(input: { body: z.infer<typeof MaterializeRequestSchema> }): Promise<z.infer<typeof MaterializeResponseSchema>> {
    const target = input.body.target as TargetId;
    let gem: Gem;
    if (input.body.archivePath) {
      gem = readGemArchive(readArchiveDir(input.body.archivePath));
    } else {
      const dirs = resolveDirs(input.body.dir);
      const inventory = introspectAll(input.body.dir, input.body.projects);
      gem = buildGem(inventory, input.body.selection!, { name: input.body.name ?? "gem", createdFrom: dirs.claudeDir });
    }
    return { target, ...materialize(gem, target), compatibility: compatibility(gem) };
  }

  @post("/archive", { body: ArchiveRequestSchema, response: ArchiveResponseSchema })
  async archive(input: { body: z.infer<typeof ArchiveRequestSchema> }): Promise<z.infer<typeof ArchiveResponseSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const gem = buildGem(inventory, input.body.selection, { name: input.body.name ?? "gem", createdFrom: dirs.claudeDir });
    const { files, skipped } = writeGemArchive(gem, { version: input.body.version });
    const lock = JSON.parse(files["gem.lock"]) as GemLock;
    let path: string | null = null;
    if (input.body.outDir) { writeArchiveDir(input.body.outDir, files); path = input.body.outDir; }
    const tarGz = input.body.tar ? packTar(files).toString("base64") : null;
    return { files, lock, skipped, path, tarGz };
  }

  @post("/workspaces", { body: CreateWorkspaceRequestSchema, response: WorkspaceSummarySchema })
  async createWorkspace(input: { body: z.infer<typeof CreateWorkspaceRequestSchema> }): Promise<z.infer<typeof WorkspaceSummarySchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const gem = buildGem(inventory, input.body.selection, { name: input.body.name, createdFrom: dirs.claudeDir });
    return createWorkspace(input.body.name, gem, { version: input.body.version });
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

  // Whether the server is configured to run/deploy the rendered eve project. Booleans only.
  @get("/run-ready", { query: RunReadyQuerySchema, response: RunReadyResponseSchema })
  async runReady(_input: { query: z.infer<typeof RunReadyQuerySchema> }): Promise<z.infer<typeof RunReadyResponseSchema>> {
    return runReadiness();
  }

  // OUTWARD-FACING (local machine): set + persist a server-side deploy/publish credential
  // (allowlisted keys only) to ~/.agentgem/.env. The value is never logged or returned.
  @post("/credential", { body: CredentialRequestSchema, response: CredentialResponseSchema })
  async credential(input: { body: z.infer<typeof CredentialRequestSchema> }): Promise<z.infer<typeof CredentialResponseSchema>> {
    setCredential(input.body.key, input.body.value);
    return { ok: true };
  }

  // OUTWARD-FACING (local machine): run the rendered eve project locally or deploy it to Vercel.
  @post("/run", { body: RunRequestSchema, response: RunStateSchema })
  async run(input: { body: z.infer<typeof RunRequestSchema> }): Promise<z.infer<typeof RunStateSchema>> {
    const { name, mode } = input.body;
    const state = mode === "cloudflare" ? await deployCloudflare(name) : mode === "vercel" ? await deployVercel(name) : await startLocal(name);
    return state;
  }

  @get("/run-status", { query: RunStatusQuerySchema, response: RunStateSchema })
  async runStatus(input: { query: z.infer<typeof RunStatusQuerySchema> }): Promise<z.infer<typeof RunStateSchema>> {
    return getRunStatus(input.query.name, input.query.target);
  }

  @post("/run/stop", { body: RunStopRequestSchema, response: RunStopResponseSchema })
  async runStop(input: { body: z.infer<typeof RunStopRequestSchema> }): Promise<z.infer<typeof RunStopResponseSchema>> {
    return stopLocal(input.body.name, input.body.target);
  }

  @get("/agentcore/deploy-ready", { query: PickQuerySchema, response: AgentcoreReadyResponseSchema })
  async agentcoreDeployReady(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof AgentcoreReadyResponseSchema>> {
    return agentcoreReadiness();
  }

  // OUTWARD-FACING: shells the agentcore CLI to deploy the workspace's rendered project to AWS.
  @post("/agentcore/deploy", { body: AgentcoreDeployRequestSchema, response: AgentcoreDeployStateSchema })
  async agentcoreDeploy(input: { body: z.infer<typeof AgentcoreDeployRequestSchema> }): Promise<z.infer<typeof AgentcoreDeployStateSchema>> {
    return deployAgentcore(input.body.name);
  }

  @get("/agentcore/deploy-status", { query: AgentcoreStatusQuerySchema, response: AgentcoreDeployStateSchema })
  async agentcoreDeployStatus(input: { query: z.infer<typeof AgentcoreStatusQuerySchema> }): Promise<z.infer<typeof AgentcoreDeployStateSchema>> {
    return getAgentcoreStatus(input.query.name);
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
    const gem = buildGem(inventory, input.body.selection, { name: input.body.name ?? "gem", createdFrom: dirs.claudeDir });
    const target = (input.body.target ?? "claude-managed") as DeployTargetId;
    return DEPLOY_REGISTRY[target].preview(gem);
  }

  // Whether the server is configured for the deploy backend (the UI gates on this). Boolean only.
  @get("/publish-ready", { query: DeployReadyQuerySchema, response: PublishReadyResponseSchema })
  async publishReady(input: { query: z.infer<typeof DeployReadyQuerySchema> }): Promise<z.infer<typeof PublishReadyResponseSchema>> {
    const target = (input.query.target ?? "claude-managed") as DeployTargetId;
    return { ready: DEPLOY_REGISTRY[target].ready() };
  }

  // OUTWARD-FACING: gated network deploy through the selected backend. The key is read server-side
  // (inside the registry's deploy) and never returned; only the redacted gem payload is sent.
  @post("/publish", { body: PublishRequestSchema, response: PublishResultSchema })
  async publish(input: { body: z.infer<typeof PublishRequestSchema> }): Promise<z.infer<typeof PublishResultSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const gem = buildGem(inventory, input.body.selection, { name: input.body.name ?? "gem", createdFrom: dirs.claudeDir });
    const target = (input.body.target ?? "claude-managed") as DeployTargetId;
    return DEPLOY_REGISTRY[target].deploy(gem, input.body.requestId);
  }

  @get("/testbed/detect", { query: TestbedDetectQuerySchema, response: TestbedDetectResponseSchema })
  async testbedDetect(input: { query: z.infer<typeof TestbedDetectQuerySchema> }): Promise<z.infer<typeof TestbedDetectResponseSchema>> {
    return { flavor: detectFlavor(resolveProject(input.query.root)) };
  }

  @get("/testbed/suggestion", { query: TestbedSuggestionQuerySchema, response: TestbedSuggestionResponseSchema })
  async testbedSuggestion(input: { query: z.infer<typeof TestbedSuggestionQuerySchema> }): Promise<z.infer<typeof TestbedSuggestionResponseSchema>> {
    const cwd = resolveProject(input.query.cwd ?? process.cwd());
    const { looksLikeProject, flavor } = suggestTestbed(cwd);
    return { cwd, looksLikeProject, flavor, name: basename(cwd) };
  }

  @get("/testbed/recents", { query: PickQuerySchema, response: TestbedRecentsResponseSchema })
  async testbedRecents(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof TestbedRecentsResponseSchema>> {
    const recents = readRecents(agentgemHome()).map((r) => ({ ...r, exists: existsSync(r.path) }));
    return { recents };
  }

  // Cross-repo discovery from Claude/Codex session history. Ungated — the front door
  // shows these under a "Discovered" section beneath the user's own recents.
  @get("/testbed/projects", { query: TestbedProjectsQuerySchema, response: TestbedProjectsResponseSchema })
  async testbedProjects(input: { query: z.infer<typeof TestbedProjectsQuerySchema> }): Promise<z.infer<typeof TestbedProjectsResponseSchema>> {
    return { projects: discoverProjects(resolveDirs(input.query.dir)) };
  }

  @post("/testbed/scaffold", { body: TestbedScaffoldRequestSchema, response: TestbedScaffoldResponseSchema })
  async scaffoldTestbed(input: { body: z.infer<typeof TestbedScaffoldRequestSchema> }): Promise<z.infer<typeof TestbedScaffoldResponseSchema>> {
    const root = resolveProject(input.body.root);
    const flavor = (input.body.flavor ?? "claude") as TestbedFlavorId;
    const res = scaffoldTestbed(root, input.body.name, flavor);
    upsertRecent(agentgemHome(), { path: root, flavor, name: input.body.name });
    return res;
  }

  @post("/testbed/import", { body: TestbedImportRequestSchema, response: TestbedImportResponseSchema })
  async importTestbed(input: { body: z.infer<typeof TestbedImportRequestSchema> }): Promise<z.infer<typeof TestbedImportResponseSchema>> {
    const rawInv = introspectConfig({ ...resolveDirs(input.body.dir), redact: false });
    return importArtifacts(resolveProject(input.body.root), input.body.selection, rawInv, (input.body.flavor ?? "claude") as TestbedFlavorId);
  }

  // Resolve the configured registry source, or throw a clear error the UI can surface.
  private registrySource() {
    const cfg = registryConfigFromEnv();
    if (!cfg) throw new Error("the registry is not configured — set AGENTGEM_REGISTRY_REPO");
    return { cfg, source: githubRegistrySource(cfg) };
  }

  @get("/registry/ready", { query: PickQuerySchema, response: RegistryReadyResponseSchema })
  async registryReady(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof RegistryReadyResponseSchema>> {
    return { ready: registryReady() };
  }

  @get("/registry/index", { query: PickQuerySchema, response: RegistryIndexResponseSchema })
  async registryIndex(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof RegistryIndexResponseSchema>> {
    return this.registrySource().source.getIndex();
  }

  @post("/registry/resolve", { body: RegistryResolveRequestSchema, response: RegistryResolveResponseSchema })
  async registryResolve(input: { body: z.infer<typeof RegistryResolveRequestSchema> }): Promise<z.infer<typeof RegistryResolveResponseSchema>> {
    const { source } = this.registrySource();
    const { plan } = await resolveInstall({ refs: input.body.refs, mode: input.body.mode, target: input.body.target as TargetId | undefined, source });
    return { plan };
  }

  // Apply: materialize into `dest`, or land the merged Gem in the workspace store.
  @post("/registry/install", { body: RegistryInstallRequestSchema, response: RegistryInstallResponseSchema })
  async registryInstall(input: { body: z.infer<typeof RegistryInstallRequestSchema> }): Promise<z.infer<typeof RegistryInstallResponseSchema>> {
    const { source } = this.registrySource();
    const { plan, gem } = await resolveInstall({ refs: input.body.refs, mode: input.body.mode, target: input.body.target as TargetId | undefined, source });
    if (input.body.mode === "materialize") {
      if (!input.body.dest) throw new Error("materialize mode requires `dest`");
      writeArchiveDir(input.body.dest, plan.materialize!.files);
      return { plan, applied: { mode: "materialize", dest: input.body.dest, written: Object.keys(plan.materialize!.files) } };
    }
    const name = input.body.workspaceName ?? gem.name;
    createWorkspace(name, gem);
    return { plan, applied: { mode: "workspace", workspace: name } };
  }

  // OUTWARD-FACING: gated network publish. Reads a Gem from the workspace, writes its archive +
  // updated index in one commit. Requires GITHUB_TOKEN (enforced by the publisher).
  @post("/registry/publish", { body: RegistryPublishRequestSchema, response: RegistryPublishResponseSchema })
  async registryPublish(input: { body: z.infer<typeof RegistryPublishRequestSchema> }): Promise<z.infer<typeof RegistryPublishResponseSchema>> {
    const { cfg, source } = this.registrySource();
    const gem = readGemArchive(readWorkspace(input.body.workspace).files); // WorkspaceDetail exposes .files, not .gem
    const index = await source.getIndex();
    return publishGem({
      gem, scope: input.body.scope, name: input.body.name, version: input.body.version,
      dependencies: input.body.dependencies, index, publisher: githubRegistryPublisher(cfg),
    });
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
