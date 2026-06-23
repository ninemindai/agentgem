// src/gem/deployRecord.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { workspaceDir } from "./workspaces.js";

export type DeployBackend = "eve" | "flue" | "claude-managed" | "agentcore";
export interface DeployRecord {
  backend: DeployBackend; at?: string; url?: string; project?: string; worker?: string;
  agentId?: string; environmentId?: string; skillIds?: string[]; harnessId?: string;
}
function recPath(name: string, backend: DeployBackend): string {
  return join(workspaceDir(name), ".deploy", `${backend}.json`);
}
export function writeDeployRecord(name: string, rec: DeployRecord): void {
  const abs = recPath(name, rec.backend);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(rec, null, 2) + "\n", "utf8");
}
export function readDeployRecord(name: string, backend: DeployBackend): DeployRecord | null {
  const abs = recPath(name, backend);
  try { return existsSync(abs) ? JSON.parse(readFileSync(abs, "utf8")) as DeployRecord : null; }
  catch { return null; }
}
export function clearDeployRecord(name: string, backend: DeployBackend): void {
  rmSync(recPath(name, backend), { force: true });
}
