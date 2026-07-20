// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/memoryRoutes.ts
//
// Local-core-only REST routes for the Memory Providers feature. Mirrors
// recallRoutes.ts's duck-typed Express pattern (no @types/express dependency).
import {
  getProvider, listProviderIds, IMPLEMENTED,
  loadProviderConfigs, saveProviderConfig,
  pullIntoRecall, readOutbox, approveAndPush,
  buildPushCandidates, writeOutbox, readPushedKeyHashes,
  type ProviderId, type ProviderConfig, type RawSignal,
} from "@agentgem/memory";
import { RecallIndex } from "@agentgem/recall";
import { defaultRecallDbPath } from "./recall.js";
import { collectSignals } from "./memorySignals.js";

// Duck-typed Express request/response so this file carries no @types/express
// dependency (mirrors recallRoutes.ts:19-41).
interface Req { body?: Record<string, unknown>; query: Record<string, unknown>; params: Record<string, string> }
interface Res { status(code: number): Res; json(body: unknown): void; setHeader(n: string, v: string): void; write(c: string): void; end(): void }
type Middleware = (req: Req, res: Res, next: () => void) => void;
interface App {
  get(path: string, guard: Middleware, handler: (req: Req, res: Res) => void | Promise<void>): void;
  post(path: string, guard: Middleware, handler: (req: Req, res: Res) => Promise<void>): void;
}
const noopGuard: Middleware = (_req, _res, next) => next();

export function registerMemoryRoutes(app: App, guard: Middleware = noopGuard): void {
  app.get("/api/memory/providers", guard, (_req, res) => {
    const cfgs = loadProviderConfigs();
    const providers = listProviderIds().map((id) => ({
      id,
      implemented: IMPLEMENTED.has(id),
      enabled: cfgs[id]?.enabled ?? false,
      connected: Boolean(cfgs[id]?.apiKey),
    }));
    res.json({ providers });
  });

  app.post("/api/memory/providers", guard, async (req, res) => {
    const id = req.body?.id as ProviderId;
    const incoming = req.body?.config as ProviderConfig;
    if (!id || !incoming) { res.status(400).json({ error: "id and config required" }); return; }
    const existing = loadProviderConfigs()[id];
    // The UI never re-populates the key field (it's write-only for security), so a save from an
    // already-connected provider arrives with a blank apiKey. Merge over the stored config: keep the
    // existing key (and any baseUrl/userId the client didn't send) unless the client provides a new value.
    const config: ProviderConfig = {
      ...existing,
      ...incoming,
      apiKey: incoming.apiKey || existing?.apiKey || "",
    };
    saveProviderConfig(id, config);
    try {
      const r = IMPLEMENTED.has(id) ? await getProvider(id).test(config) : { ok: false, detail: "not implemented yet" };
      res.json(r);
    } catch (e) { res.json({ ok: false, detail: String((e as Error).message) }); }
  });

  app.post("/api/memory/pull", guard, async (req, res) => {
    const id = req.body?.id as ProviderId;
    const cfg = loadProviderConfigs()[id];
    if (!cfg?.enabled) { res.status(400).json({ error: "provider not enabled" }); return; }
    const index = new RecallIndex(defaultRecallDbPath());
    try {
      const r = await pullIntoRecall(getProvider(id), cfg, index);
      res.json(r);
    } finally { index.close(); }
  });

  app.get("/api/memory/outbox", guard, (_req, res) => {
    res.json({ candidates: readOutbox() });
  });

  app.post("/api/memory/outbox/refresh", guard, async (_req, res) => {
    const signals: RawSignal[] = await collectSignals();
    const candidates = buildPushCandidates(signals, readPushedKeyHashes());
    writeOutbox(candidates);
    res.json({ candidates });
  });

  app.post("/api/memory/push", guard, async (req, res) => {
    const keys = (req.body?.keys as string[]) ?? [];
    res.json(await approveAndPush(keys));
  });
}
