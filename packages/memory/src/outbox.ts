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
export function readPushedKeys(): Set<string> {
  return new Set(readJson<string[]>("memory-pushed-keys.json", []));
}
function writePushedKeys(keys: Set<string>): void {
  writeJson("memory-pushed-keys.json", [...keys]);
}

/** Push the approved candidates to every enabled provider, then remove them from
 *  the outbox and record their keys so they are never re-queued or re-sent. */
export async function approveAndPush(keys: string[]): Promise<{ pushed: number; skipped: number }> {
  const outbox = readOutbox();
  const approved = outbox.filter((c) => keys.includes(c.key));
  const cfgs = loadProviderConfigs();
  const enabled = listProviderIds().filter((id: ProviderId) => cfgs[id]?.enabled);

  let pushed = 0;
  let skipped = 0;
  const pushedKeys = readPushedKeys();

  for (const cand of approved) {
    if (enabled.length === 0) { skipped++; continue; }
    for (const id of enabled) {
      await getProvider(id).push(cfgs[id]!, cand);
      pushed++;
    }
    pushedKeys.add(cand.key);
  }

  writePushedKeys(pushedKeys);
  writeOutbox(outbox.filter((c) => !pushedKeys.has(c.key)));
  return { pushed, skipped };
}
