// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// supermemory REST adapter (hosted default https://api.supermemory.ai).
//
// Confirmed against docs.supermemory.ai (2026-07-14): listing is
// POST /v3/documents/list returning `{ memories: [...] }` sorted by updatedAt,
// items expose `title`/`summary` (no full `content`); adding is
// POST /v3/documents and returns an immediate `{ id, status }` (synchronous id).

import type { MemoryProvider, MemoryRecord, ProviderConfig, PushCandidate } from "../types.js";

const DEFAULT_BASE = "https://api.supermemory.ai";

function headers(cfg: ProviderConfig): Record<string, string> {
  return { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" };
}
function base(cfg: ProviderConfig): string {
  return (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
}
function containerTags(cfg: ProviderConfig): string[] | undefined {
  return cfg.userId ? [cfg.userId] : undefined;
}

interface SmRow { id: string; title?: string; summary?: string; updatedAt?: string; metadata?: Record<string, unknown> }

export const supermemoryProvider: MemoryProvider = {
  id: "supermemory",

  async test(cfg) {
    const res = await fetch(`${base(cfg)}/v3/documents/list`, {
      method: "POST", headers: headers(cfg),
      body: JSON.stringify({ limit: 1, containerTags: containerTags(cfg) }),
    });
    return res.ok ? { ok: true } : { ok: false, detail: `supermemory returned ${res.status}` };
  },

  async *pull(cfg, since) {
    // v1 limitation: fetches only the newest page (limit 200), does NOT follow
    // `pagination.totalPages`. For an incremental pull the desc sort + early-break
    // on `since` makes 200 sufficient unless >200 memories changed between syncs; a
    // FIRST pull (since undefined) of a >200 container silently indexes only the 200
    // newest. Follow-up: paginate when a second/first full backfill matters.
    const res = await fetch(`${base(cfg)}/v3/documents/list`, {
      method: "POST", headers: headers(cfg),
      body: JSON.stringify({ limit: 200, sort: "updatedAt", order: "desc", containerTags: containerTags(cfg) }),
    });
    if (!res.ok) throw new Error(`supermemory pull failed: ${res.status}`);
    const body = (await res.json()) as { memories?: SmRow[] };
    for (const row of body.memories ?? []) {
      const updatedAt = row.updatedAt ? Date.parse(row.updatedAt) : 0;
      // desc-sorted by updatedAt → once we pass the cursor, everything after is older too.
      if (since !== undefined && updatedAt <= since) break;
      const text = [row.title, row.summary].filter(Boolean).join(" — ");
      if (!text) continue;
      yield { id: row.id, text, updatedAt, metadata: row.metadata } satisfies MemoryRecord;
    }
  },

  async push(cfg, m: PushCandidate) {
    const res = await fetch(`${base(cfg)}/v3/documents`, {
      method: "POST", headers: headers(cfg),
      body: JSON.stringify({ content: m.text, containerTags: containerTags(cfg) }),
    });
    if (!res.ok) throw new Error(`supermemory push failed: ${res.status}`);
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new Error("supermemory push: no id in response");
    return { id: body.id };
  },
};
