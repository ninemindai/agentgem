import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { createLogger } from "@agentgem/base";

const log = createLogger("benchmark");

function cfgPath(base: string): string {
  return join(base, ".agentgem", "benchmark", "config.json");
}
export function benchmarkContribute(base: string = agentgemHome()): boolean {
  try {
    const cfg = JSON.parse(readFileSync(cfgPath(base), "utf8")) as { enabled?: boolean };
    if (typeof cfg.enabled === "boolean") return cfg.enabled;
  } catch { /* fall through to env */ }
  const env = process.env.AGENTGEM_BENCHMARK_CONTRIBUTE;
  return env === "1" || env === "true";
}
export function setBenchmarkContribute(enabled: boolean, base: string = agentgemHome()): void {
  try {
    const p = cfgPath(base);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ enabled }, null, 2), "utf8");
  } catch (err) { log.warn("config write failed (ignored): %s", (err as Error)?.message ?? err); }
}
