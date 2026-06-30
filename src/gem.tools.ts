// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem.tools.ts
import { z } from "zod";
import { mcpServer, tool } from "@agentback/mcp";
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { buildGem } from "@agentgem/build";
import type { ConfigInventory } from "@agentgem/model";
import { GemSelectionSchema } from "./schemas.js";
import { resolveDirs, resolveProject } from "@agentgem/model";
import { resolveInstall, publishGem } from "@agentgem/distribute";
import { searchIndex } from "@agentgem/distribute";
import type { TargetId } from "@agentgem/model";
import { githubRegistrySource, githubRegistryPublisher, registryConfigFromEnv } from "@agentgem/distribute";
import { readWorkspace } from "@agentgem/base";
import { readGemArchive } from "@agentgem/archive";
import { exportGem, importGem } from "@agentgem/distribute";
import { fetchGemBytes } from "@agentgem/distribute";
import { sendBytes, receiveTicket, natsStoreFromEnv, assertConfigured } from "@agentgem/transfer";
import { readFileSync } from "node:fs";
import { service } from "@agentback/core";
import { GemTypeRegistry, defaultGemTypeRegistry, resolvePublishType } from "./gem/gemTypeRegistry.js";

const InventoryInput = z.object({ dir: z.string().optional(), projects: z.array(z.string()).optional() });
const GemInput = z.object({ selection: GemSelectionSchema, name: z.string().optional(), dir: z.string().optional(), projects: z.array(z.string()).optional() });
const RegistryRefsInput = z.object({ refs: z.array(z.string()).min(1), mode: z.enum(["materialize", "workspace"]), target: z.string().optional(), a2aServer: z.boolean().optional() });
const RegistryPublishInput = z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), dependencies: z.array(z.string()).optional(), description: z.string().optional(), tags: z.array(z.string()).optional(), type: z.string().optional() });
const RegistrySearchInput = z.object({ q: z.string().optional(), kind: z.string().optional(), tag: z.string().optional(), limit: z.number().int().positive().max(100).optional() });
const GemExportInput = z.object({ selection: GemSelectionSchema, name: z.string().optional(), version: z.string().optional(), dir: z.string().optional(), projects: z.array(z.string()).optional() });
const GemInstallInput = z.object({ gemUrl: z.string().optional(), gemPath: z.string().optional(), bytesBase64: z.string().optional() });
const TransferSendInput = z.object({ selection: GemSelectionSchema, name: z.string().optional(), version: z.string().optional(), dir: z.string().optional(), projects: z.array(z.string()).optional() });
const TransferReceiveInput = z.object({ ticket: z.string() });

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
  constructor(@service(GemTypeRegistry, { optional: true }) private gemTypes: GemTypeRegistry = defaultGemTypeRegistry) {}

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

  @tool("gem_export", {
    description: "Export a Gem (built from a selection of the local config) as a single portable .gem archive, returned base64-encoded. Share those bytes as a file/upload/gist; install elsewhere with gem_install. Secrets are redacted; no registry required.",
    input: GemExportInput,
  })
  async gemExport(input: z.infer<typeof GemExportInput>) {
    const dirs = resolveDirs(input.dir);
    const gem = buildGem(introspectAll(input.dir, input.projects), input.selection, { name: input.name ?? "gem", createdFrom: dirs.claudeDir });
    const { filename, bytes, skipped } = exportGem(gem, { version: input.version });
    return { filename, bytesBase64: bytes.toString("base64"), skipped };
  }

  @tool("gem_install", {
    description: "Read and verify a shared .gem from a URL, local file path, or base64 bytes — returning the lock-verified Gem and its manifest meta. URL fetches are SSRF-guarded; tampered archives are rejected. Disk placement is performed via the REST /materialize endpoint.",
    input: GemInstallInput,
  })
  async gemInstall(input: z.infer<typeof GemInstallInput>) {
    const bytes = input.gemUrl ? await fetchGemBytes(input.gemUrl)
      : input.gemPath ? readFileSync(input.gemPath)
      : input.bytesBase64 ? Buffer.from(input.bytesBase64, "base64")
      : (() => { throw new Error("provide one of gemUrl, gemPath, or bytesBase64"); })();
    return importGem(bytes);
  }

  @tool("transfer_send", {
    description: "Share a Gem (built from a selection of the local config) store-and-forward: encrypts it client-side and stashes the ciphertext in the configured NATS Object Store, returning a one-time `agentgem://` ticket. Hand the ticket to a friend/coworker or your other device; they redeem it with transfer_receive. The broker never sees plaintext. Requires NATS_URL.",
    input: TransferSendInput,
  })
  async transferSend(input: z.infer<typeof TransferSendInput>) {
    assertConfigured(); // fail fast before building/exporting the gem
    const dirs = resolveDirs(input.dir);
    const gem = buildGem(introspectAll(input.dir, input.projects), input.selection, { name: input.name ?? "gem", createdFrom: dirs.claudeDir });
    const { bytes } = exportGem(gem, { version: input.version });
    const { ticket } = await sendBytes(bytes, natsStoreFromEnv());
    return { ticket };
  }

  @tool("transfer_receive", {
    description: "Redeem an `agentgem://` ticket: fetches the ciphertext from the configured NATS Object Store, decrypts it with the key carried in the ticket, verifies integrity (gem.lock), and returns the verified Gem + manifest meta. The object is burned after the first successful fetch. Requires NATS_URL. Disk placement is performed via the REST /materialize endpoint.",
    input: TransferReceiveInput,
  })
  async transferReceive(input: z.infer<typeof TransferReceiveInput>) {
    const { gem, meta } = await receiveTicket(input.ticket, natsStoreFromEnv());
    return { gem, meta };
  }

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
