// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Play JSON routes over the miniapps registry: save (gate + dual-write), list, publish (git push).
import { api, get, post, AgentError } from "@agentback/openapi";
import { z } from "zod";
import { saveMiniapp, listMiniapps, readMiniapp, miniappsRoot, setRemote, push, seedStudio, importStudio, compactTurns } from "@agentgem/play";
import { defaultReaders } from "./play.readers.js";
import {
  PlaySaveRequestSchema, PlaySaveResponseSchema, MiniappListSchema,
  PlayPublishRequestSchema, PlayPublishResponseSchema,
  PlayStudioRequestSchema, PlayStudioResponseSchema, PlayImportRequestSchema,
  PlayMiniappQuerySchema, PlayMiniappSchema, PlaySessionDataSchema,
} from "./schemas.js";

@api({ basePath: "/api" })
export class PlayController {
  @post("/play/save", { body: PlaySaveRequestSchema, response: PlaySaveResponseSchema })
  async save(input: { body: z.infer<typeof PlaySaveRequestSchema> }): Promise<z.infer<typeof PlaySaveResponseSchema>> {
    try {
      return await saveMiniapp({ name: input.body.name, html: input.body.html, meta: input.body.meta });
    } catch (e) { throw new AgentError((e as Error).message, { status: 400 }); }
  }

  @post("/play/studio", { body: PlayStudioRequestSchema, response: PlayStudioResponseSchema })
  async studio(input: { body: z.infer<typeof PlayStudioRequestSchema> }): Promise<z.infer<typeof PlayStudioResponseSchema>> {
    try {
      const { name } = await seedStudio(input.body.source, defaultReaders);
      return { name };
    } catch (e) { throw new AgentError((e as Error).message, { status: 400 }); }
  }

  @post("/play/import", { body: PlayImportRequestSchema, response: PlayStudioResponseSchema })
  async import(input: { body: z.infer<typeof PlayImportRequestSchema> }): Promise<z.infer<typeof PlayStudioResponseSchema>> {
    try {
      const { name } = await importStudio(input.body.title, input.body.html);
      return { name };
    } catch (e) { throw new AgentError((e as Error).message, { status: 400 }); }
  }

  // Host-brokered feed: the miniapp's OWN source-session transcript, compacted. Only session-sourced
  // miniapps have it. The Runner fetches this and postMessages it into the sealed iframe on demand.
  @get("/play/session-data", { query: PlayMiniappQuerySchema, response: PlaySessionDataSchema })
  async sessionData(input: { query: z.infer<typeof PlayMiniappQuerySchema> }): Promise<z.infer<typeof PlaySessionDataSchema>> {
    try {
      const src = readMiniapp(input.query.name).meta.createdFrom;
      if (src.kind !== "session") throw new Error("this miniapp has no session data");
      const s = await defaultReaders.loadSession(src.sessionId, src.agent);
      if (!s) throw new Error("session not found");
      return { meta: (s.meta ?? {}) as Record<string, unknown>, timeline: compactTurns(s.turns) };
    } catch (e) { throw new AgentError((e as Error).message, { status: 404 }); }
  }

  @get("/play/miniapps", { response: MiniappListSchema })
  async miniapps(): Promise<z.infer<typeof MiniappListSchema>> {
    return { miniapps: listMiniapps().map((m) => ({ name: m.name, title: m.meta.title, genre: m.meta.genre, ...(m.meta.needs ? { needs: m.meta.needs } : {}) })) };
  }

  @get("/play/miniapp", { query: PlayMiniappQuerySchema, response: PlayMiniappSchema })
  async miniapp(input: { query: z.infer<typeof PlayMiniappQuerySchema> }): Promise<z.infer<typeof PlayMiniappSchema>> {
    try {
      const r = readMiniapp(input.query.name);
      return { name: r.name, html: r.html, meta: { title: r.meta.title, genre: r.meta.genre, createdFrom: r.meta.createdFrom, engineVersion: r.meta.engineVersion, ...(r.meta.needs ? { needs: r.meta.needs } : {}) } };
    } catch (e) { throw new AgentError((e as Error).message, { status: 404 }); }
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
