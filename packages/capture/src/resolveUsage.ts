// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/capture/src/resolveUsage.ts
//
// The query-time half of the transcript index. `raw_usage` stores tokens exactly as the
// transcript carried them; this maps them onto the CURRENT inventory and folds them into the
// global result. Because nothing here is persisted, installing a skill changes the answer with
// no file re-read.
//
// Lives in capture (not insight) because it returns GlobalUsageResult, which capture defines.
// Capture imports insight; the reverse would be a cycle.
import { matchSkill, matchMcpServer } from "@agentgem/insight";
import type { GlobalUsageResult } from "./globalUsage.js";

export interface StoredRawRow { path: string; kind: "skill" | "mcp_server"; token: string; invocations: number; lastUsedMs: number | null }
export interface StoredHookRow { path: string; name: string; invocations: number; lastUsedMs: number | null }

interface Acc { type: string; name: string; invocations: number; paths: Set<string>; lastUsedMs: number | null }

function fold(acc: Map<string, Acc>, type: string, name: string, path: string, invocations: number, lastUsedMs: number | null): void {
  const key = `${type} ${name}`;
  const e = acc.get(key) ?? { type, name, invocations: 0, paths: new Set<string>(), lastUsedMs: null };
  e.invocations += invocations;
  e.paths.add(path);
  if (lastUsedMs != null) e.lastUsedMs = e.lastUsedMs == null ? lastUsedMs : Math.max(e.lastUsedMs, lastUsedMs);
  acc.set(key, e);
}

export function resolveUsage(
  raw: StoredRawRow[],
  hooks: StoredHookRow[],
  global: { skills: { name: string }[]; mcpServers: { name: string }[] },
): GlobalUsageResult {
  const acc = new Map<string, Acc>();
  for (const r of raw) {
    // Same exported matchers, same inventory order, as the resolved-at-parse path used.
    const name = r.kind === "skill" ? matchSkill(global.skills, r.token) : matchMcpServer(r.token, global.mcpServers);
    if (name === null) continue; // unresolved: retained in the table, omitted from the result
    fold(acc, r.kind, name, r.path, r.invocations, r.lastUsedMs);
  }
  for (const h of hooks) fold(acc, "hook", h.name, h.path, h.invocations, h.lastUsedMs);

  return {
    artifacts: [...acc.values()]
      .map((e) => ({
        type: e.type,
        name: e.name,
        root: null as null,
        invocations: e.invocations,
        // `sessionsUsedIn` has always meant DISTINCT TRANSCRIPT FILES: touch()'s `sessionId`
        // parameter receives `path` at every call site. Counting paths is exactly equivalent,
        // and makes two-tokens-one-artifact impossible to double-count.
        sessionsUsedIn: e.paths.size,
        lastUsedMs: e.lastUsedMs,
      }))
      .sort((a, b) => b.invocations - a.invocations || a.name.localeCompare(b.name)),
  };
}
