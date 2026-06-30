// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/recents.ts
// Persisted "testbeds you've opened in agentgem" — a small JSON list under ~/.agentgem.
// Pure store: takes an explicit home dir, computes no fs-existence (the endpoint adds that).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestbedFlavorId } from "@agentgem/testbed";

const CAP = 10;

export interface RecentEntry {
  path: string;
  flavor: TestbedFlavorId;
  name: string;
  lastUsed: string;
}

function recentsFile(home: string): string {
  return join(home, ".agentgem", "recents.json");
}

function isEntry(v: unknown): v is RecentEntry {
  const e = v as Record<string, unknown>;
  return !!e && typeof e.path === "string" && typeof e.flavor === "string"
    && typeof e.name === "string" && typeof e.lastUsed === "string";
}

export function readRecents(home: string): RecentEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(recentsFile(home), "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

// Move/insert `e` at the front (deduped by path), stamp lastUsed, cap, persist.
// Best-effort write: a non-writable ~/.agentgem must not break opening a testbed.
export function upsertRecent(home: string, e: { path: string; flavor: TestbedFlavorId; name: string }): RecentEntry[] {
  const entry: RecentEntry = { ...e, lastUsed: new Date().toISOString() };
  const rest = readRecents(home).filter((r) => r.path !== entry.path);
  const next = [entry, ...rest].slice(0, CAP);
  try {
    const abs = recentsFile(home);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    console.warn(`agentgem: could not write recents to ${recentsFile(home)}`);
  }
  return next;
}
