// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Local record of "this machine's producer key is bound to GitHub @login" — mirrors what
// `agentgem bind` writes, so the console and CLI share one source of truth.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Binding { provider: string; login: string; accountId: string; boundAt: string }

const defaultDir = (): string => join(homedir(), ".agentgem");

export function readBinding(dir: string = defaultDir()): Binding | null {
  try {
    const raw = readFileSync(join(dir, "binding.json"), "utf8");
    const b = JSON.parse(raw) as Partial<Binding>;
    if (typeof b.login === "string" && typeof b.provider === "string" && typeof b.accountId === "string" && typeof b.boundAt === "string") {
      return { provider: b.provider, login: b.login, accountId: b.accountId, boundAt: b.boundAt };
    }
    return null;
  } catch {
    return null; // absent or malformed → not connected
  }
}

export function writeBinding(b: Binding, dir: string = defaultDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "binding.json"), JSON.stringify(b), { mode: 0o600 });
}
