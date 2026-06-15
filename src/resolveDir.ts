// src/resolveDir.ts
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveDir(dir?: string): string {
  return dir && dir.length > 0 ? dir : join(homedir(), ".claude");
}
