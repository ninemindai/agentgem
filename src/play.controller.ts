// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Play JSON routes over the miniapps registry: save (gate + dual-write), list, publish (git push).
import { api, get, post, AgentError } from "@agentback/openapi";
import { z } from "zod";
import { saveMiniapp, listMiniapps, miniappsRoot, setRemote, push } from "@agentgem/play";
import {
  PlaySaveRequestSchema, PlaySaveResponseSchema, MiniappListSchema,
  PlayPublishRequestSchema, PlayPublishResponseSchema,
} from "./schemas.js";

@api({ basePath: "/api" })
export class PlayController {
  @post("/play/save", { body: PlaySaveRequestSchema, response: PlaySaveResponseSchema })
  async save(input: { body: z.infer<typeof PlaySaveRequestSchema> }): Promise<z.infer<typeof PlaySaveResponseSchema>> {
    try {
      return await saveMiniapp({ name: input.body.name, html: input.body.html, meta: input.body.meta });
    } catch (e) { throw new AgentError((e as Error).message, { status: 400 }); }
  }

  @get("/play/miniapps", { response: MiniappListSchema })
  async miniapps(): Promise<z.infer<typeof MiniappListSchema>> {
    return { miniapps: listMiniapps().map((m) => ({ name: m.name, title: m.meta.title, genre: m.meta.genre })) };
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
