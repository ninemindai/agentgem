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

// Corpus token of the last successful `contribute` warm pass, persisted to disk (NOT
// module-scoped state) so the `contribute` warmable can cheaply short-circuit an
// unchanged corpus across process restarts. Read fresh on every warm() call.
function tokenPath(base: string): string {
  return join(base, ".agentgem", "benchmark", "last-token");
}
export function readContributeToken(base: string = agentgemHome()): string | null {
  try {
    const token = readFileSync(tokenPath(base), "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
export function writeContributeToken(token: string, base: string = agentgemHome()): void {
  try {
    const p = tokenPath(base);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, token, "utf8");
  } catch (err) { log.warn("contribute token write failed (ignored): %s", (err as Error)?.message ?? err); }
}
