import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import type { ProviderId } from "./types.js";

function cursorPath(): string {
  return join(agentgemHome(), ".agentgem", "memory-cursors.json");
}

function load(): Partial<Record<ProviderId, number>> {
  const p = cursorPath();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
}

export function readCursor(id: ProviderId): number | undefined {
  return load()[id];
}

export function writeCursor(id: ProviderId, ms: number): void {
  const p = cursorPath();
  mkdirSync(dirname(p), { recursive: true });
  const all = load();
  all[id] = ms;
  writeFileSync(p, JSON.stringify(all, null, 2));
}
