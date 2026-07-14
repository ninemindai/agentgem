// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import type { ProviderConfig, ProviderId } from "./types.js";

type ConfigMap = Partial<Record<ProviderId, ProviderConfig>>;

export function configPath(): string {
  return join(agentgemHome(), ".agentgem", "memory-providers.json");
}

export function loadProviderConfigs(): ConfigMap {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ConfigMap;
  } catch {
    return {};
  }
}

export function saveProviderConfig(id: ProviderId, cfg: ProviderConfig): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const all = loadProviderConfigs();
  all[id] = cfg;
  writeFileSync(p, JSON.stringify(all, null, 2), { mode: 0o600 });
}
