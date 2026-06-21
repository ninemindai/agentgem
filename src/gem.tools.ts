// src/gem.tools.ts
import { z } from "zod";
import { mcpServer, tool } from "@agentback/mcp";
import { introspectConfig, introspectProject } from "./gem/introspect.js";
import { buildGem } from "./gem/buildGem.js";
import type { ConfigInventory } from "./gem/types.js";
import { GemSelectionSchema } from "./schemas.js";
import { resolveDirs, resolveProject } from "./resolveDir.js";
import { resolveInstall, publishGem } from "./gem/registry.js";
import type { TargetId } from "./gem/targets.js";
import { githubRegistrySource, githubRegistryPublisher, registryConfigFromEnv } from "./gem/registryGithub.js";
import { readWorkspace } from "./gem/workspaces.js";
import { readGemArchive } from "./gem/archive.js";

const InventoryInput = z.object({ dir: z.string().optional(), projects: z.array(z.string()).optional() });
const GemInput = z.object({ selection: GemSelectionSchema, name: z.string().optional(), dir: z.string().optional(), projects: z.array(z.string()).optional() });
const RegistryRefsInput = z.object({ refs: z.array(z.string()).min(1), mode: z.enum(["materialize", "workspace"]), target: z.string().optional() });
const RegistryPublishInput = z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), dependencies: z.array(z.string()).optional() });

function registrySourceOrThrow() {
  const cfg = registryConfigFromEnv();
  if (!cfg) throw new Error("the registry is not configured — set AGENTGEM_REGISTRY_REPO");
  return { cfg, source: githubRegistrySource(cfg) };
}

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

  @tool("build_gem", {
    description: "Build a redacted Gem from a selection of the introspected config artifacts.",
    input: GemInput,
  })
  async gem(input: z.infer<typeof GemInput>) {
    const dirs = resolveDirs(input.dir);
    return buildGem(introspectAll(input.dir, input.projects), input.selection, { name: input.name ?? "gem", createdFrom: dirs.claudeDir });
  }

  @tool("registry_index", { description: "List the gems available in the configured registry (names, versions, dependencies).", input: z.object({}) })
  async registryIndex(_input: Record<string, never>) {
    return registrySourceOrThrow().source.getIndex();
  }

  @tool("registry_resolve", { description: "Resolve registry refs into an install plan (items, artifacts, required secrets, and a materialize preview for a target). No writes.", input: RegistryRefsInput })
  async registryResolve(input: z.infer<typeof RegistryRefsInput>) {
    const { source } = registrySourceOrThrow();
    const { plan } = await resolveInstall({ refs: input.refs, mode: input.mode, target: input.target as TargetId | undefined, source });
    return plan;
  }

  @tool("registry_install", { description: "Resolve + merge registry refs, returning the merged Gem and install plan. (Disk/workspace placement is performed via the REST /registry/install endpoint.)", input: RegistryRefsInput })
  async registryInstall(input: z.infer<typeof RegistryRefsInput>) {
    const { source } = registrySourceOrThrow();
    const { plan, gem } = await resolveInstall({ refs: input.refs, mode: input.mode, target: input.target as TargetId | undefined, source });
    return { plan, gem };
  }

  @tool("registry_publish", { description: "Publish a workspace Gem to the registry as @scope/name@version (requires GITHUB_TOKEN).", input: RegistryPublishInput })
  async registryPublish(input: z.infer<typeof RegistryPublishInput>) {
    const { cfg, source } = registrySourceOrThrow();
    const gem = readGemArchive(readWorkspace(input.workspace).files);
    const index = await source.getIndex();
    return publishGem({ gem, scope: input.scope, name: input.name, version: input.version, dependencies: input.dependencies, index, publisher: githubRegistryPublisher(cfg) });
  }
}
