// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// GitHub-registry routes (ready / index / search / resolve / install / publish) and MCP tools
// (registry_index / registry_search / registry_resolve / registry_install / registry_publish) —
// moved out of the gem controller/tools so those carry no registry deps.
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import type { RestApplication } from "@agentback/rest";
import { RestBindings } from "@agentback/rest";
import { mcpServer, tool } from "@agentback/mcp";
import { service, inject } from "@agentback/core";
import { DrizzleBindings } from "@agentback/drizzle";
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import type { TargetId } from "@agentgem/model";
import { resolveInstall, publishGem, searchIndex } from "@agentgem/distribute";
import { githubRegistrySource, githubRegistryPublisher, registryConfigFromEnv, registryReady } from "@agentgem/distribute";
import { readGemArchive } from "@agentgem/archive";
import { writeArchiveDir } from "@agentgem/archive";
import { createWorkspace, readWorkspace } from "@agentgem/base";
import { installRubricGem } from "./rubricCore.js";
import { emitAdoption } from "./registry/emitAdoption.js";
import { GemTypeRegistry, defaultGemTypeRegistry, resolvePublishType } from "./gem/gemTypeRegistry.js";
import { AUTH_BINDING, PUBLISHED_BY_RESOLVER } from "./hostedBindings.js";
import {
  PickQuerySchema,
  RegistryReadyResponseSchema, RegistryIndexResponseSchema,
  RegistrySearchQuerySchema, RegistrySearchResponseSchema,
  RegistryResolveRequestSchema, RegistryResolveResponseSchema,
  RegistryInstallRequestSchema, RegistryInstallResponseSchema,
  RegistryPublishRequestSchema, RegistryPublishResponseSchema,
} from "./schemas.js";

const RegistryRefsInput = z.object({ refs: z.array(z.string()).min(1), mode: z.enum(["materialize", "workspace"]), target: z.string().optional(), a2aServer: z.boolean().optional() });
const RegistryPublishInput = z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), dependencies: z.array(z.string()).optional(), description: z.string().optional(), tags: z.array(z.string()).optional(), type: z.string().optional() });
const RegistrySearchInput = z.object({ q: z.string().optional(), kind: z.string().optional(), tag: z.string().optional(), limit: z.number().int().positive().max(100).optional() });

// Resolve the configured registry source, or throw a clear error the UI can surface. Shared by
// RegistryController (REST) and RegistryTools (MCP) — same lookup, two surfaces.
function registrySourceOrThrow() {
  const cfg = registryConfigFromEnv();
  if (!cfg) throw new Error("the registry is not configured — set AGENTGEM_REGISTRY_REPO");
  return { cfg, source: githubRegistrySource(cfg) };
}

@api({ basePath: "/api" })
export class RegistryController {
  constructor(
    @service(GemTypeRegistry, { optional: true }) private gemTypes: GemTypeRegistry = defaultGemTypeRegistry,
    @inject(RestBindings.HTTP_REQUEST, { optional: true }) private req?: { headers: Record<string, string | undefined> },
    @inject(DrizzleBindings.CLIENT, { optional: true }) private db?: AppDb,
    @inject(AUTH_BINDING, { optional: true }) private auth?: ReturnType<typeof makeAuth>,
    @inject(PUBLISHED_BY_RESOLVER, { optional: true }) private resolvePublishedBy?: import("./hostedBindings.js").PublishedByResolver,
  ) {}

  @get("/registry/ready", { query: PickQuerySchema, response: RegistryReadyResponseSchema })
  async registryReady(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof RegistryReadyResponseSchema>> {
    return { ready: registryReady() };
  }

  @get("/registry/index", { query: PickQuerySchema, response: RegistryIndexResponseSchema })
  async registryIndex(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof RegistryIndexResponseSchema>> {
    return registrySourceOrThrow().source.getIndex();
  }

  @get("/registry/search", { query: RegistrySearchQuerySchema, response: RegistrySearchResponseSchema })
  async registrySearch(input: { query: z.infer<typeof RegistrySearchQuerySchema> }): Promise<z.infer<typeof RegistrySearchResponseSchema>> {
    const index = await registrySourceOrThrow().source.getIndex();
    return { results: searchIndex(index, input.query.q ?? "", { kind: input.query.kind, tag: input.query.tag, limit: input.query.limit }) };
  }

  @post("/registry/resolve", { body: RegistryResolveRequestSchema, response: RegistryResolveResponseSchema })
  async registryResolve(input: { body: z.infer<typeof RegistryResolveRequestSchema> }): Promise<z.infer<typeof RegistryResolveResponseSchema>> {
    const { source } = registrySourceOrThrow();
    const { plan } = await resolveInstall({ refs: input.body.refs, mode: input.body.mode, target: input.body.target as TargetId | undefined, source, a2aServer: input.body.a2aServer });
    return { plan };
  }

  // Apply: materialize into `dest`, or land the merged Gem in the workspace store.
  @post("/registry/install", { body: RegistryInstallRequestSchema, response: RegistryInstallResponseSchema })
  async registryInstall(input: { body: z.infer<typeof RegistryInstallRequestSchema> }): Promise<z.infer<typeof RegistryInstallResponseSchema>> {
    const { source } = registrySourceOrThrow();
    const { plan, gem } = await resolveInstall({ refs: input.body.refs, mode: input.body.mode, target: input.body.target as TargetId | undefined, source, a2aServer: input.body.a2aServer });
    // Validate mode-specific inputs BEFORE any install side-effect (a rejected install writes nothing).
    if (input.body.mode === "materialize" && !input.body.dest) throw new Error("materialize mode requires `dest`");
    // Adoption fires only AFTER the install actually lands (below), never on a resolve-then-fail.
    const installed = plan.items.map((it) => ({ gemKey: it.key, version: it.version, gemDigest: "" }));
    if (input.body.mode === "materialize") {
      const dest = input.body.dest!;   // guarded above
      writeArchiveDir(dest, plan.materialize!.files);
      const rubrics = installRubricGem(gem);   // after the materialize write lands — like installHosted/applyGem, so a failed install writes no rubric
      void emitAdoption(installed);   // opt-in + fire-and-forget; never awaited, never throws
      return { plan, applied: { mode: "materialize", dest, written: Object.keys(plan.materialize!.files) }, rubrics };
    }
    const name = input.body.workspaceName ?? gem.name;
    createWorkspace(name, gem);
    const rubrics = installRubricGem(gem);   // after the workspace lands — a name-collision throw leaves no orphaned rubric
    void emitAdoption(installed);   // opt-in + fire-and-forget; never awaited, never throws
    return { plan, applied: { mode: "workspace", workspace: name }, rubrics };
  }

  // OUTWARD-FACING: gated network publish. Reads a Gem from the workspace, writes its archive +
  // updated index in one commit. Requires GITHUB_TOKEN (enforced by the publisher).
  @post("/registry/publish", { body: RegistryPublishRequestSchema, response: RegistryPublishResponseSchema })
  async registryPublish(input: { body: z.infer<typeof RegistryPublishRequestSchema> }): Promise<z.infer<typeof RegistryPublishResponseSchema>> {
    const { cfg, source } = registrySourceOrThrow();
    const gem = readGemArchive(readWorkspace(input.body.workspace).files); // WorkspaceDetail exposes .files, not .gem
    const type = resolvePublishType(this.gemTypes, input.body.type, gem);
    const index = await source.getIndex();
    const publishedBy = this.resolvePublishedBy ? await this.resolvePublishedBy(this.req, this.auth, this.db) : undefined;
    return publishGem({
      gem, scope: input.body.scope, name: input.body.name, version: input.body.version,
      dependencies: input.body.dependencies, index, publisher: githubRegistryPublisher(cfg),
      description: input.body.description, tags: input.body.tags, type, publishedBy,
      grade: gem.grade,
    });
  }
}

// The MCP counterpart to RegistryController: same registry operations, exposed as MCP tools
// instead of REST routes. A separate @mcpServer() service — AgentBack aggregates @tool methods
// across every registered @mcpServer class onto the same MCP endpoint, so registering this
// alongside GemTools keeps the tool surface identical to before the move.
@mcpServer()
export class RegistryTools {
  constructor(@service(GemTypeRegistry, { optional: true }) private gemTypes: GemTypeRegistry = defaultGemTypeRegistry) {}

  @tool("registry_index", { description: "List the gems available in the configured registry (names, versions, dependencies).", input: z.object({}) })
  async registryIndex(_input: Record<string, never>) {
    return registrySourceOrThrow().source.getIndex();
  }

  @tool("registry_search", { description: "Search the configured registry for gems by name/tags/description. Pass a `kind` (skill|mcp_server|instructions|hook) or `tag` to filter; an empty query browses the catalog. Returns ranked hits with latest version and description.", input: RegistrySearchInput })
  async registrySearch(input: z.infer<typeof RegistrySearchInput>) {
    const index = await registrySourceOrThrow().source.getIndex();
    return { results: searchIndex(index, input.q ?? "", { kind: input.kind, tag: input.tag, limit: input.limit }) };
  }

  @tool("registry_resolve", { description: "Resolve registry refs into an install plan (items, artifacts, required secrets, and a materialize preview for a target). No writes.", input: RegistryRefsInput })
  async registryResolve(input: z.infer<typeof RegistryRefsInput>) {
    const { source } = registrySourceOrThrow();
    const { plan } = await resolveInstall({ refs: input.refs, mode: input.mode, target: input.target as TargetId | undefined, source, a2aServer: input.a2aServer });
    return plan;
  }

  @tool("registry_install", { description: "Resolve + merge registry refs, returning the merged Gem and install plan. (Disk/workspace placement is performed via the REST /registry/install endpoint.)", input: RegistryRefsInput })
  async registryInstall(input: z.infer<typeof RegistryRefsInput>) {
    const { source } = registrySourceOrThrow();
    const { plan, gem } = await resolveInstall({ refs: input.refs, mode: input.mode, target: input.target as TargetId | undefined, source, a2aServer: input.a2aServer });
    return { plan, gem };
  }

  @tool("registry_publish", { description: "Publish a workspace Gem to the registry as @scope/name@version (requires GITHUB_TOKEN).", input: RegistryPublishInput })
  async registryPublish(input: z.infer<typeof RegistryPublishInput>) {
    const { cfg, source } = registrySourceOrThrow();
    const gem = readGemArchive(readWorkspace(input.workspace).files);
    const type = resolvePublishType(this.gemTypes, input.type, gem);
    const index = await source.getIndex();
    return publishGem({ gem, scope: input.scope, name: input.name, version: input.version, dependencies: input.dependencies, index, publisher: githubRegistryPublisher(cfg), description: input.description, tags: input.tags, type });
  }
}

export function registerRegistry(app: RestApplication): void {
  app.restController(RegistryController);
}
