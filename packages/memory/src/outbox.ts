// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Local outbox store + consent-gated push executor.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import type { ProviderId, PushCandidate } from "./types.js";
import { getProvider, listProviderIds } from "./registry.js";
import { loadProviderConfigs } from "./config.js";

function statePath(name: string): string {
  return join(agentgemHome(), ".agentgem", name);
}
function readJson<T>(name: string, fallback: T): T {
  const p = statePath(name);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return fallback; }
}
function writeJson(name: string, value: unknown): void {
  const p = statePath(name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(value, null, 2));
}

export function readOutbox(): PushCandidate[] {
  return readJson<PushCandidate[]>("memory-outbox.json", []);
}
export function writeOutbox(cands: PushCandidate[]): void {
  writeJson("memory-outbox.json", cands);
}
/** Joins a provider id and a candidate key into the re-push guard's storage key. */
function pairKey(providerId: string, key: string): string {
  return `${providerId}:${key}`;
}
/** Legacy pushed-keys files stored bare content hashes, back when mem0 was the
 *  only provider. Any entry without a ":" is a legacy hash and is migrated to
 *  "mem0:<hash>"; entries already in "providerId:key" form are left as-is. */
export function readPushedKeys(): Set<string> {
  const raw = readJson<string[]>("memory-pushed-keys.json", []);
  return new Set(raw.map((e) => (e.includes(":") ? e : pairKey("mem0", e))));
}
function writePushedKeys(keys: Set<string>): void {
  writeJson("memory-pushed-keys.json", [...keys]);
}

/** The set of candidate content-hashes that have been pushed to AT LEAST ONE provider.
 *  Derived from the pair-form pushed-keys (providerId:key) by stripping the providerId.
 *  Used by candidate generation to avoid re-queueing an already-delivered memory;
 *  per-provider dedup at push time is handled separately by approveAndPush's pair guard. */
export function readPushedKeyHashes(): Set<string> {
  return new Set([...readPushedKeys()].map((p) => p.slice(p.indexOf(":") + 1)));
}

/** Push the approved candidates to every enabled provider, guarding re-pushes on
 *  a per-(providerId, key) pair rather than per-key: with multiple providers, a
 *  candidate can be fully sent to one provider but not another. Each successful
 *  provider push is persisted immediately, so if a later push() throws, the
 *  earlier successes are already durable on disk and a retry will not re-send
 *  them to that provider. A candidate is removed from the outbox only once every
 *  enabled provider's pair has been recorded (fully delivered). */
export async function approveAndPush(keys: string[]): Promise<{ pushed: number; skipped: number }> {
  let outbox = readOutbox();
  const pushedKeys = readPushedKeys();
  const approved = outbox.filter((c) => keys.includes(c.key));
  const cfgs = loadProviderConfigs();
  const enabled = listProviderIds().filter((id: ProviderId) => cfgs[id]?.enabled);

  let pushed = 0;
  let skipped = 0;

  for (const cand of approved) {
    if (enabled.length === 0) { skipped++; continue; }
    for (const id of enabled) {
      const pk = pairKey(id, cand.key);
      if (pushedKeys.has(pk)) continue;
      await getProvider(id).push(cfgs[id]!, cand);
      pushed++;
      pushedKeys.add(pk);
      writePushedKeys(pushedKeys);
    }
    if (enabled.every((id) => pushedKeys.has(pairKey(id, cand.key)))) {
      outbox = outbox.filter((c) => c.key !== cand.key);
      writeOutbox(outbox);
    }
  }

  return { pushed, skipped };
}
