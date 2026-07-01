import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";

function cfgPath(base: string): string {
  return join(base, ".agentgem", "dream", "config.json");
}
export function dreamEnabled(base: string = agentgemHome()): boolean {
  try {
    const cfg = JSON.parse(readFileSync(cfgPath(base), "utf8")) as { enabled?: boolean };
    if (typeof cfg.enabled === "boolean") return cfg.enabled;
  } catch { /* fall through to env */ }
  const env = process.env.AGENTGEM_DREAM_ENABLED;
  return env === "1" || env === "true";
}
export function setDreamEnabled(enabled: boolean, base: string = agentgemHome()): void {
  try {
    const p = cfgPath(base);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ enabled }, null, 2), "utf8");
  } catch (err) { console.error("dream: config write failed (ignored):", (err as Error).message); }
}
