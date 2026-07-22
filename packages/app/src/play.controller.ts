// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Play JSON routes over the miniapps registry: save (gate + dual-write), list, publish (git push).
import { api, get, post, AgentError } from "@agentback/openapi";
import { inject } from "@agentback/core";
import { z } from "zod";
import {
  saveMiniapp, deleteMiniapp, listMiniapps, readMiniapp, miniappsRoot, setRemote, push, seedStudio, importStudio, blankStudio,
  compactTurns, resolveSessionRef, mcpAppFor, migrateAllMiniapps, INSPECTOR_HTML, INSPECTOR_META, type MiniappMeta,
  EMBER_HTML, EMBER_META, REPO_PULSE_HTML, REPO_PULSE_META, readMiniappShare, addUploadsToMiniapp,
  callConnectorTool, listConnectorTools, listConnectorCandidates, resolveConnectorGem, resolveConnectorDigest, ConnectorError,
} from "@agentgem/play";
import { derivePayload, type McpNeed } from "@agentgem/model";
import type { FabricRouter } from "@agentgem/fabric";
import { FABRIC_ROUTER, MCP_ASK_TIMEOUT_MS, mapAskFailure, type McpAskReply } from "./fabric.binding.js";
import { defaultReaders } from "./play.readers.js";
import { listActiveSessions } from "./watchSessions.js";
import {
  PlaySaveRequestSchema, PlaySaveResponseSchema, PlayDeleteRequestSchema, PlayDeleteResponseSchema, MiniappListSchema,
  PlayPublishRequestSchema, PlayPublishResponseSchema,
  PlayStudioRequestSchema, PlayStudioResponseSchema, PlayImportRequestSchema, PlayBlankRequestSchema,
  PlayMiniappQuerySchema, PlayMiniappSchema, PlaySessionDataSchema, PlaySessionDataQuerySchema, PlayMcpAppSchema,
  PlayMigrateResponseSchema, PlayInspectorSchema,
  PlayMcpCallRequestSchema, PlayMcpCallResponseSchema, PlayMcpServersQuerySchema, PlayMcpServersResponseSchema,
  PlayMcpCandidatesResponseSchema, PlayMcpCandidateToolsQuerySchema, PlayMcpCandidateToolsResponseSchema,
  PlayUploadsRequestSchema, PlayUploadsResponseSchema,
} from "./schemas.js";

@api({ basePath: "/api" })
export class PlayController {
  // Optional so bare-controller embeddings (no DI container, e.g. the direct-construction unit
  // tests) keep the pre-fabric direct-call path byte-identical — see mcpCall below.
  constructor(
    @inject(FABRIC_ROUTER, { optional: true }) private fabricRouter?: FabricRouter,
  ) {}

  @post("/play/save", { body: PlaySaveRequestSchema, response: PlaySaveResponseSchema })
  async save(input: { body: z.infer<typeof PlaySaveRequestSchema> }): Promise<z.infer<typeof PlaySaveResponseSchema>> {
    try {
      return await saveMiniapp({ name: input.body.name, html: input.body.html, meta: input.body.meta });
    } catch (e) { throw new AgentError((e as Error).message, { status: 400 }); }
  }

  // Removal is a git commit in the registry, so it stays recoverable from history; the dual-written
  // gem is dropped only when play authored it (see deleteMiniapp).
  //
  // Only an absent miniapp is a 404. A malformed/traversing name is a client error (400), matching the
  // sibling save/studio/import/blank routes and chatRoutes.ts — collapsing both into 404 would report a
  // rejected `../escape` as "not found", and would report a genuine git failure as "not found" too.
  @post("/play/delete", { body: PlayDeleteRequestSchema, response: PlayDeleteResponseSchema })
  async delete(input: { body: z.infer<typeof PlayDeleteRequestSchema> }): Promise<z.infer<typeof PlayDeleteResponseSchema>> {
    try {
      return await deleteMiniapp(input.body.name);
    } catch (e) {
      const msg = (e as Error).message;
      throw new AgentError(msg, { status: msg.startsWith("miniapp not found") ? 404 : 400 });
    }
  }

  // A user-typed `name` that is already taken is a 409, not a 400: the request was well-formed, the id
  // just isn't free. Everything else (a malformed name, an unreadable source) stays a 400.
  private createError(e: unknown): AgentError {
    const msg = (e as Error).message;
    return new AgentError(msg, { status: msg.startsWith("miniapp already exists") ? 409 : 400 });
  }

  @post("/play/studio", { body: PlayStudioRequestSchema, response: PlayStudioResponseSchema })
  async studio(input: { body: z.infer<typeof PlayStudioRequestSchema> }): Promise<z.infer<typeof PlayStudioResponseSchema>> {
    try {
      const { name } = await seedStudio(input.body.source, defaultReaders, input.body.name, input.body.genre);
      return { name };
    } catch (e) { throw this.createError(e); }
  }

  @post("/play/import", { body: PlayImportRequestSchema, response: PlayStudioResponseSchema })
  async import(input: { body: z.infer<typeof PlayImportRequestSchema> }): Promise<z.infer<typeof PlayStudioResponseSchema>> {
    try {
      const { name } = await importStudio(input.body.title, input.body.html, input.body.name, input.body.files);
      return { name };
    } catch (e) { throw this.createError(e); }
  }

  @post("/play/blank", { body: PlayBlankRequestSchema, response: PlayStudioResponseSchema })
  async blank(input: { body: z.infer<typeof PlayBlankRequestSchema> }): Promise<z.infer<typeof PlayStudioResponseSchema>> {
    try {
      const { name } = await blankStudio(input.body.title, input.body.prompt, input.body.name, input.body.files);
      return { name };
    } catch (e) { throw this.createError(e); }
  }

  // Add files to an EXISTING miniapp's workspace (e.g. mid-Studio-session uploads), as opposed to
  // import/blank which seed files at creation time. 404 for an unknown miniapp, matching delete's
  // "miniapp not found" prefix convention; everything else (bad name, oversize, bad base64) is 400.
  @post("/play/uploads", { body: PlayUploadsRequestSchema, response: PlayUploadsResponseSchema })
  async uploads(input: { body: z.infer<typeof PlayUploadsRequestSchema> }): Promise<z.infer<typeof PlayUploadsResponseSchema>> {
    try {
      return await addUploadsToMiniapp(input.body.name, input.body.files);
    } catch (e) {
      const msg = (e as Error).message;
      throw new AgentError(msg, { status: msg.startsWith("miniapp not found") ? 404 : 400 });
    }
  }

  // Host-brokered feed: a replay's source-session transcript, compacted. Defaults to the miniapp's OWN
  // (author) session; a viewer may override with one of THEIR local sessions (validated against
  // listActiveSessions so a crafted client can't request an arbitrary transcript).
  @get("/play/session-data", { query: PlaySessionDataQuerySchema, response: PlaySessionDataSchema })
  async sessionData(input: { query: z.infer<typeof PlaySessionDataQuerySchema> }): Promise<z.infer<typeof PlaySessionDataSchema>> {
    try {
      const { name, sessionId, agent } = input.query;
      const src = readMiniapp(name).meta.createdFrom;
      const ref = resolveSessionRef(src, { sessionId, agent }, listActiveSessions().map((s) => ({ id: s.id, agent: s.agent })));
      const s = await defaultReaders.loadSession(ref.sessionId, ref.agent);
      if (!s) throw new Error("session not found");
      return { meta: (s.meta ?? {}) as Record<string, unknown>, timeline: compactTurns(s.turns) };
    } catch (e) { throw new AgentError((e as Error).message, { status: 404 }); }
  }

  @get("/play/miniapps", { response: MiniappListSchema })
  async miniapps(): Promise<z.infer<typeof MiniappListSchema>> {
    // Built-in EMBER is a served constant (never in the registry) but IS listed so it shows as an Arcade
    // card — prepended so it leads the grid. `miniapp()` special-cases its name below.
    const builtins = [
      { name: EMBER_META.name, title: EMBER_META.title, genre: EMBER_META.genre, needs: EMBER_META.needs },
      { name: REPO_PULSE_META.name, title: REPO_PULSE_META.title, genre: REPO_PULSE_META.genre },
    ];
    const registry = listMiniapps().map((m) => ({ name: m.name, title: m.meta.title, genre: m.meta.genre, ...(m.meta.needs ? { needs: m.meta.needs } : {}) }));
    return { miniapps: [...builtins, ...registry] };
  }

  @get("/play/miniapp", { query: PlayMiniappQuerySchema, response: PlayMiniappSchema })
  async miniapp(input: { query: z.infer<typeof PlayMiniappQuerySchema> }): Promise<z.infer<typeof PlayMiniappSchema>> {
    // "__ember" is a constant (packages/play/src/ember.ts), never written to the registry, so it must be
    // resolved BEFORE readMiniapp (which would 404). Mirrors the "__inspector" special-case in mcpApp().
    if (input.query.name === EMBER_META.name) {
      return { name: EMBER_META.name, html: EMBER_HTML, meta: {
        title: EMBER_META.title, genre: EMBER_META.genre, createdFrom: EMBER_META.createdFrom,
        engineVersion: EMBER_META.engineVersion, needs: EMBER_META.needs,
      } };
    }
    // "__repo-pulse" (packages/play/src/repoPulse.ts) — the connectors demo built-in; its manifest
    // rides meta.mcpNeeds so Studio's Runner attaches the mcp router (same read path as saved apps).
    if (input.query.name === REPO_PULSE_META.name) {
      return { name: REPO_PULSE_META.name, html: REPO_PULSE_HTML, meta: {
        title: REPO_PULSE_META.title, genre: REPO_PULSE_META.genre, createdFrom: REPO_PULSE_META.createdFrom,
        engineVersion: REPO_PULSE_META.engineVersion, mcpNeeds: REPO_PULSE_META.mcpNeeds,
      } };
    }
    try {
      const r = readMiniapp(input.query.name);
      const share = readMiniappShare(input.query.name);
      return {
        name: r.name, html: r.html,
        meta: {
          title: r.meta.title, genre: r.meta.genre, createdFrom: r.meta.createdFrom, engineVersion: r.meta.engineVersion,
          ...(r.meta.needs ? { needs: r.meta.needs } : {}),
          ...(r.meta.mcpNeeds ? { mcpNeeds: r.meta.mcpNeeds } : {}),
        },
        ...(share ? { share } : {}),
      };
    } catch (e) { throw new AgentError((e as Error).message, { status: 404 }); }
  }

  // Serve-time MCP Apps adapter: the same stored miniapp, re-shaped as a ui:// resource + launcher tool.
  // No behavior change to storage or the sealed runtime — this is a producer-side view over readMiniapp.
  //
  // "__inspector" is special-cased BEFORE readMiniapp: it is a constant (packages/play/src/inspector.ts),
  // never written to the registry, so readMiniapp(name) would 404 on it.
  @get("/play/mcp-app", { query: PlayMiniappQuerySchema, response: PlayMcpAppSchema })
  async mcpApp(input: { query: z.infer<typeof PlayMiniappQuerySchema> }): Promise<z.infer<typeof PlayMcpAppSchema>> {
    if (input.query.name === INSPECTOR_META.name) {
      return mcpAppFor({ name: INSPECTOR_META.name, html: INSPECTOR_HTML, meta: INSPECTOR_META as MiniappMeta });
    }
    try {
      return mcpAppFor(readMiniapp(input.query.name));
    } catch (e) { throw new AgentError((e as Error).message, { status: 404 }); }
  }

  // The built-in Protocol Inspector: a conformance harness that exercises every capability, served as a
  // CONSTANT — never written to (or read from) the miniapps registry. Mirrors the /play/miniapp response
  // shape so the console can reuse its existing miniapp-viewer plumbing unchanged.
  @get("/play/inspector", { response: PlayInspectorSchema })
  async inspector(): Promise<z.infer<typeof PlayInspectorSchema>> {
    return {
      name: INSPECTOR_META.name, html: INSPECTOR_HTML,
      meta: {
        title: INSPECTOR_META.title, genre: INSPECTOR_META.genre, createdFrom: INSPECTOR_META.createdFrom,
        engineVersion: INSPECTOR_META.engineVersion, needs: [...INSPECTOR_META.needs],
      },
    };
  }

  // Codemod pass over the whole registry: rewrites old-bridge miniapps' STORED files to the current MCP
  // Apps client shim. Optimization only — readMiniapp()'s on-read backstop already serves migrated html
  // regardless of whether this route has ever run.
  @post("/play/migrate", { response: PlayMigrateResponseSchema })
  async migrate(): Promise<z.infer<typeof PlayMigrateResponseSchema>> {
    try {
      return { results: await migrateAllMiniapps() };
    } catch (e) { throw new AgentError((e as Error).message, { status: 400 }); }
  }

  @post("/play/publish", { body: PlayPublishRequestSchema, response: PlayPublishResponseSchema })
  async publish(input: { body: z.infer<typeof PlayPublishRequestSchema> }): Promise<z.infer<typeof PlayPublishResponseSchema>> {
    const root = miniappsRoot();
    try {
      if (input.body.remote) await setRemote(root, input.body.remote);
      await push(root);
      return { ok: true };
    } catch (e) { throw new AgentError(`publish failed: ${(e as Error).message}`, { status: 400 }); }
  }

  // A built-in's connector manifest lives in its served constant, not the registry (readMiniapp
  // throws for "__" names). Only Repo Pulse declares one; EMBER/Inspector have none, so falling
  // through to readMiniapp keeps their (correct) 404 behavior on the mcp routes.
  private builtinMcpNeeds(name: string): McpNeed[] | undefined {
    return name === REPO_PULSE_META.name ? REPO_PULSE_META.mcpNeeds : undefined;
  }

  @post("/play/mcp/call", { body: PlayMcpCallRequestSchema, response: PlayMcpCallResponseSchema })
  async mcpCall(input: { body: z.infer<typeof PlayMcpCallRequestSchema> }): Promise<z.infer<typeof PlayMcpCallResponseSchema>> {
    const { name, server, tool, input: args, expectedConfigDigest } = input.body;
    // 404 for an unknown miniapp (an AgentError, not an envelope error — the CALLER is malformed).
    // A built-in's manifest lives in its served constant — readMiniapp() throws for "__" names.
    let mcpNeeds = this.builtinMcpNeeds(name);
    if (!mcpNeeds) {
      try { mcpNeeds = readMiniapp(name).meta.mcpNeeds ?? []; }
      catch (e) { throw new AgentError((e as Error).message, { status: 404 }); }
    }
    // THE SECURITY BOUNDARY: refuse any (server, tool) the SAVED manifest does not grant, before we
    // ever touch the connector. The console consent gate (PR-3) is UX; this is enforcement.
    const declared = mcpNeeds.find((n) => n.server === server);
    if (!declared || !declared.tools.includes(tool)) {
      return { ok: false, error: { code: "not_in_manifest", message: `"${server}"/"${tool}" is not in this miniapp's declared connectors` } };
    }
    // Digest re-check (D3/D7): AFTER the manifest check, BEFORE ever calling the connector. A caller
    // that omits expectedConfigDigest (a non-console caller) skips this — the console always sends it.
    if (expectedConfigDigest !== undefined) {
      const liveDigest = resolveConnectorDigest(server);
      // An uninstalled connector resolves to `undefined`, not a changed digest — report the connector
      // as not connected rather than misleadingly telling the caller its consent is stale.
      if (liveDigest === undefined) {
        return { ok: false, error: { code: "server_not_connected", message: `MCP server "${server}" is not installed` } };
      }
      if (expectedConfigDigest !== liveDigest) {
        return { ok: false, error: { code: "server_config_changed", message: "connector config changed since consent — re-approve" } };
      }
    }
    try {
      const raw = this.fabricRouter
        ? await this.fabricRouter.ask("agentgem://self/mcp", "mcp.tool.call", { server, tool, input: args }, { timeoutMs: MCP_ASK_TIMEOUT_MS })
        : undefined;
      if (raw === undefined) {
        //  No router bound (bare-controller embeddings): the direct path keeps behavior identical.
        const result = await callConnectorTool(server, tool, args);
        return { ok: true, payload: derivePayload(result as Parameters<typeof derivePayload>[0]), content: result.content };
      }
      const reply = raw as McpAskReply;
      if (!reply.ok) return { ok: false, error: { code: reply.code as never, message: reply.message } };
      return { ok: true, payload: derivePayload(reply.result as Parameters<typeof derivePayload>[0]), content: reply.result.content };
    } catch (e) {
      if (e instanceof ConnectorError) return { ok: false, error: { code: e.code, message: e.message } };
      const mapped = mapAskFailure(e);
      return { ok: false, error: { code: mapped.code as never, message: mapped.message } };
    }
  }

  @get("/play/mcp/servers", { query: PlayMcpServersQuerySchema, response: PlayMcpServersResponseSchema })
  async mcpServers(input: { query: z.infer<typeof PlayMcpServersQuerySchema> }): Promise<z.infer<typeof PlayMcpServersResponseSchema>> {
    let mcpNeeds = this.builtinMcpNeeds(input.query.name);
    if (!mcpNeeds) {
      try { mcpNeeds = readMiniapp(input.query.name).meta.mcpNeeds ?? []; }
      catch (e) { throw new AgentError((e as Error).message, { status: 404 }); }
    }
    const servers = [];
    for (const need of mcpNeeds) {
      // A declared server with no matching installed gem lists with EMPTY tools (the not-connected
      // shape). A failed listTools (connect error) also degrades to empty tools rather than failing
      // the whole route — one connector down must not blind the app to the others.
      if (!resolveConnectorGem(need.server)) { servers.push({ server: need.server, tools: [] }); continue; }
      const configDigest = resolveConnectorDigest(need.server);
      try { servers.push({ server: need.server, tools: await listConnectorTools(need.server), configDigest }); }
      catch { servers.push({ server: need.server, tools: [], configDigest }); }
    }
    return { servers };
  }

  // Candidate picker source (Studio Composer): the installed MCP servers a miniapp COULD declare.
  // Redacted (name + transport + needsSecret) — no connect, no config values.
  @get("/play/mcp/candidates", { response: PlayMcpCandidatesResponseSchema })
  async mcpCandidates(): Promise<z.infer<typeof PlayMcpCandidatesResponseSchema>> {
    return { servers: listConnectorCandidates() };
  }

  // Lazy tools for one candidate, fetched only when the author expands its row. No installed gem →
  // empty (skip the doomed connect); a connect failure on an installed gem also degrades to empty
  // rather than failing the route (one connector down must not blind the picker).
  @get("/play/mcp/candidate-tools", { query: PlayMcpCandidateToolsQuerySchema, response: PlayMcpCandidateToolsResponseSchema })
  async mcpCandidateTools(input: { query: z.infer<typeof PlayMcpCandidateToolsQuerySchema> }): Promise<z.infer<typeof PlayMcpCandidateToolsResponseSchema>> {
    if (!resolveConnectorGem(input.query.server)) return { tools: [] };
    try { return { tools: await listConnectorTools(input.query.server) }; }
    catch { return { tools: [] }; }
  }
}
