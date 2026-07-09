// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Namespaced, leveled logging for AgentGem, built on @agentback/common's
// debug-based loggers. One wrapper so every package logs the same way:
//
//   import { createLogger, maskSecret } from "@agentgem/base";
//   const log = createLogger("run");                 // namespace "agentgem:run"
//   log.info("spawning %s in %s", cmd, cwd);
//   log.warn("token exchange failed: %s", err.message);
//   log.debug("payload %o", body);                   // hidden unless LOG_LEVEL=debug
//
// Levels (least→most verbose): error, warn, info, debug, trace — gated by the
// LOG_LEVEL env var (default "info").
//
// WHY the boot config below: @agentback/common's loggers are `debug`-based and
// therefore *silent* unless their namespace is enabled (via DEBUG). The console.*
// calls these replace always printed, so to avoid silently swallowing errors we
// enable `agentgem:*` at LOG_LEVEL=info by default. An operator who sets DEBUG or
// LOG_LEVEL themselves stays fully in control — we never override an explicit value.
//
// Redaction: the underlying loggers auto-mask object keys containing
// KEY/PASSWORD/SECRET/TOKEN/… (see redactData). That match is case-sensitive and
// key-name based, so it misses camelCase keys and raw secret *values* — always
// pass known secrets through maskSecret() (or don't log them) rather than relying
// on it. The optional file sink additionally value-scrubs each line.
import {
  loggers,
  enableDebug,
  setLogLevel,
  onLog,
  LogLevel,
  maskSecret,
  redactData,
  type LogHook,
} from "@agentback/common";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redactStrongCredentials } from "@agentgem/model";

/** The five level loggers for a namespace: `{ error, warn, info, debug, trace }`. */
export type Logger = ReturnType<typeof loggers>;

export { LogLevel, maskSecret, redactData };
export type { LogHook };

const ROOT = "agentgem";

let configured = false;

/** Configure default log visibility once per process (see file header for the why). */
function ensureConfigured(): void {
  if (configured) return;
  configured = true;
  // `debug` is silent by default; enable our namespaces unless the operator scoped output.
  if (!process.env.DEBUG) enableDebug(`${ROOT}:*`);
  // Threshold: default to info so error/warn/info surface and debug/trace stay opt-in.
  if (!process.env.LOG_LEVEL && !process.env.DEBUG_PINO) setLogLevel(LogLevel.INFO);
  installFileSink();
}

/**
 * Opt-in persistent sink for warn/error, enabled via AGENTGEM_LOG_FILE (a path,
 * or "1"/"true" for the default ~/.agentgem/agentgem.log). Best-effort and
 * value-scrubbed; a failing write must never break the caller's logging.
 */
function installFileSink(): void {
  const setting = process.env.AGENTGEM_LOG_FILE;
  if (!setting) return;
  const path =
    setting === "1" || setting.toLowerCase() === "true"
      ? join(homedir(), ".agentgem", "agentgem.log")
      : setting;
  void mkdir(dirname(path), { recursive: true }).catch(() => {});
  const hook: LogHook = (namespace: string, level: LogLevel, args: unknown[]) => {
    const line =
      redactStrongCredentials(
        JSON.stringify({ level, ns: namespace, msg: args }),
      ) + "\n";
    void appendFile(path, line).catch(() => {});
  };
  onLog(hook);
}

/**
 * Get the level loggers for an AgentGem subsystem. `area` becomes the namespace
 * `agentgem:<area>` (e.g. "run", "warm", "auth", "gem", "insight").
 */
export function createLogger(area: string): Logger {
  ensureConfigured();
  return loggers(`${ROOT}:${area}`);
}

/**
 * Register a global hook fired on every warn/error (args already redacted) — the
 * seam to forward errors to an external sink. Returns a dispose function.
 */
export function onWarnOrError(hook: LogHook): () => void {
  return onLog(hook);
}
