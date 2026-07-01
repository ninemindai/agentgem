// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/agentgemConfig.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Resolve the paths lazily (per call) rather than at module load, so the config honors
// the current HOME — matters for the hermetic-home test fixture and for any HOME change.
const configDir = (): string => join(homedir(), ".agentgem");
const configPath = (): string => join(configDir(), "config.json");

interface AgentgemConfig {
  shareAdoption?: boolean;
}

function readConfig(): AgentgemConfig {
  try {
    const path = configPath();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as AgentgemConfig;
  } catch {
    return {};
  }
}

export function readShareAdoption(): boolean {
  return !!readConfig().shareAdoption;
}

export function setShareAdoption(v: boolean): void {
  try {
    mkdirSync(configDir(), { recursive: true });
    const current = readConfig();
    const updated = { ...current, shareAdoption: v };
    writeFileSync(configPath(), JSON.stringify(updated, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort; silently ignore write errors
  }
}
