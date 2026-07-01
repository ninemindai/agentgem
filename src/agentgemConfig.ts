// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/agentgemConfig.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".agentgem");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

interface AgentgemConfig {
  shareAdoption?: boolean;
}

function readConfig(): AgentgemConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as AgentgemConfig;
  } catch {
    return {};
  }
}

export function readShareAdoption(): boolean {
  return !!readConfig().shareAdoption;
}

export function setShareAdoption(v: boolean): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const current = readConfig();
    const updated = { ...current, shareAdoption: v };
    writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort; silently ignore write errors
  }
}
