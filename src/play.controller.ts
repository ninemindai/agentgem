// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Play JSON routes over the miniapps registry: save (gate + dual-write), list, publish (git push).
import { api, get, post, AgentError } from "@agentback/openapi";
import { z } from "zod";
import {
  saveMiniapp, deleteMiniapp, listMiniapps, readMiniapp, miniappsRoot, setRemote, push, seedStudio, importStudio, blankStudio,
  compactTurns, resolveSessionRef, mcpAppFor, migrateAllMiniapps, INSPECTOR_HTML, INSPECTOR_META, type MiniappMeta,
  EMBER_HTML, EMBER_META, readMiniappShare,
} from "@agentgem/play";
import { defaultReaders } from "./play.readers.js";
import { listActiveSessions } from "./watchSessions.js";
import {
  PlaySaveRequestSchema, PlaySaveResponseSchema, PlayDeleteRequestSchema, PlayDeleteResponseSchema, MiniappListSchema,
  PlayPublishRequestSchema, PlayPublishResponseSchema,
  PlayStudioRequestSchema, PlayStudioResponseSchema, PlayImportRequestSchema, PlayBlankRequestSchema,
  PlayMiniappQuerySchema, PlayMiniappSchema, PlaySessionDataSchema, PlaySessionDataQuerySchema, PlayMcpAppSchema,
  PlayMigrateResponseSchema, PlayInspectorSchema,
} from "./schemas.js";

@api({ basePath: "/api" })
export class PlayController {
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
      const { name } = await importStudio(input.body.title, input.body.html, input.body.name);
      return { name };
    } catch (e) { throw this.createError(e); }
  }

  @post("/play/blank", { body: PlayBlankRequestSchema, response: PlayStudioResponseSchema })
  async blank(input: { body: z.infer<typeof PlayBlankRequestSchema> }): Promise<z.infer<typeof PlayStudioResponseSchema>> {
    try {
      const { name } = await blankStudio(input.body.title, input.body.prompt, input.body.name);
      return { name };
    } catch (e) { throw this.createError(e); }
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
    const builtins = [{ name: EMBER_META.name, title: EMBER_META.title, genre: EMBER_META.genre, needs: EMBER_META.needs }];
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
    try {
      const r = readMiniapp(input.query.name);
      const share = readMiniappShare(input.query.name);
      return {
        name: r.name, html: r.html,
        meta: { title: r.meta.title, genre: r.meta.genre, createdFrom: r.meta.createdFrom, engineVersion: r.meta.engineVersion, ...(r.meta.needs ? { needs: r.meta.needs } : {}) },
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
}
