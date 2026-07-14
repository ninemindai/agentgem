// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// mem0 REST adapter (hosted default https://api.mem0.ai).
//
// Confirmed against docs.mem0.ai/api-reference/memory/{add-memories,get-memories}
// (2026-07-13): the current API is versioned /v3/, listing is POST (not GET) with
// user_id inside a `filters` object, and adding is asynchronous — it returns a
// queued `event_id`, not an immediate memory id.

import type { MemoryProvider, MemoryRecord, ProviderConfig, PushCandidate } from "../types.js";

const DEFAULT_BASE = "https://api.mem0.ai";

function headers(cfg: ProviderConfig): Record<string, string> {
  return { Authorization: `Token ${cfg.apiKey}`, "Content-Type": "application/json" };
}
function base(cfg: ProviderConfig): string {
  return (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
}

function listMemories(cfg: ProviderConfig): Promise<Response> {
  return fetch(`${base(cfg)}/v3/memories/`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({ filters: { user_id: cfg.userId } }),
  });
}

interface Mem0Row { id: string; memory?: string; text?: string; updated_at?: string; metadata?: Record<string, unknown> }

export const mem0Provider: MemoryProvider = {
  id: "mem0",

  async test(cfg) {
    const res = await listMemories(cfg);
    if (res.ok) return { ok: true };
    return { ok: false, detail: `mem0 returned ${res.status}` };
  },

  async *pull(cfg, since) {
    let res = await listMemories(cfg);
    if (!res.ok) throw new Error(`mem0 pull failed: ${res.status}`);
    let body = (await res.json()) as { results?: Mem0Row[]; next?: string | null };
    for (;;) {
      for (const row of body.results ?? []) {
        const text = row.memory ?? row.text ?? "";
        const updatedAt = row.updated_at ? Date.parse(row.updated_at) : 0;
        if (!text) continue;
        if (since !== undefined && updatedAt <= since) continue;
        yield { id: row.id, text, updatedAt, metadata: row.metadata } satisfies MemoryRecord;
      }
      if (!body.next) break;
      res = await fetch(body.next, { headers: headers(cfg) });
      if (!res.ok) throw new Error(`mem0 pull failed: ${res.status}`);
      body = (await res.json()) as { results?: Mem0Row[]; next?: string | null };
    }
  },

  async push(cfg, m: PushCandidate) {
    const res = await fetch(`${base(cfg)}/v3/memories/add/`, {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify({ messages: [{ role: "user", content: m.text }], user_id: cfg.userId }),
    });
    if (!res.ok) throw new Error(`mem0 push failed: ${res.status}`);
    const body = (await res.json()) as { event_id?: string };
    const id = body.event_id;
    if (!id) throw new Error("mem0 push: no event_id in response");
    return { id };
  },
};
