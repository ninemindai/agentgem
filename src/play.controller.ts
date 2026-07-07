// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Play JSON routes over the miniapps registry: save (gate + dual-write), list, publish (git push).
import { api, get, post, AgentError } from "@agentback/openapi";
import { z } from "zod";
import { saveMiniapp, listMiniapps, readMiniapp, miniappsRoot, setRemote, push, seedStudio } from "@agentgem/play";
import { defaultReaders } from "./play.readers.js";
import {
  PlaySaveRequestSchema, PlaySaveResponseSchema, MiniappListSchema,
  PlayPublishRequestSchema, PlayPublishResponseSchema,
  PlayStudioRequestSchema, PlayStudioResponseSchema,
  PlayMiniappQuerySchema, PlayMiniappSchema,
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
