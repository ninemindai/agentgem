// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/daemon.ts
//
// Trigger C daemon: acquire a pidfile singleton, warm current state once, then
// watch for changes. runWarmCommand is the testable CLI entry (all process
// interaction injected). Best-effort; never throws out of the happy path.
import { join } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { runWarmPass } from "./orchestrator.js";
import { startWarmWatch, warmRootsIndividually } from "./watch.js";
import { acquirePidfile, releasePidfile } from "./pidfile.js";
import { withWarmLock } from "./lock.js";
import { startUsageReporter, type UsageReporter } from "../usage/reporter.js";
import { createHygieneNudger } from "./hygieneNudger.js";
import { nodeNotify } from "./nodeNotify.js";
import { hygieneReportForFile } from "../sessionHygieneCore.js";
import { createLogger } from "@agentgem/base";

const warmLog = createLogger("warm");

export interface WarmDaemon { stop(): Promise<void> }

export function startWarmDaemon(opts: {
  home?: string;
  onLog?: (m: string) => void;
  watch?: typeof startWarmWatch;
  initialPass?: () => Promise<unknown>;
  usageReporter?: typeof startUsageReporter;
  nudge?: boolean;
} = {}): WarmDaemon | null {
  const home = opts.home ?? agentgemHome();
  const log = opts.onLog ?? ((m: string) => warmLog.info("%s", m));
  const startWatch = opts.watch ?? startWarmWatch;
  const initialPass = opts.initialPass ?? (() => withWarmLock(home, () => runWarmPass(), () => undefined));
  const pidPath = join(home, ".agentgem", "warm.pid");

  if (!acquirePidfile(pidPath)) { log("agentgem warm: another daemon is already running; exiting."); return null; }
  void initialPass();                        // fire-and-forget: warm current state
  // The daemon is the schedule host for team-usage reporting: bound machines push their daily
  // rollups to the aggregator on an interval (throttled + signed-out-safe inside the reporter).
  const reporter: UsageReporter = (opts.usageReporter ?? startUsageReporter)({ home });
  const nudger = opts.nudge ? createHygieneNudger({ notify: nodeNotify, reportForFile: hygieneReportForFile }) : null;
  const w = startWatch({
    run: (roots) => withWarmLock(home, () => warmRootsIndividually(roots), () => undefined),
    ...(nudger ? { nudge: (files: string[]) => nudger.nudge(files) } : {}),
  });
  return { async stop() { try { w.stop(); reporter.stop(); } finally { releasePidfile(pidPath); } } };
}

export function runWarmCommand(argv: string[], deps: {
  start?: typeof startWarmDaemon;
  log?: (m: string) => void;
  errorLog?: (m: string) => void;
  exit?: (code: number) => void;
  on?: (sig: "SIGINT" | "SIGTERM", cb: () => void) => void;
} = {}): WarmDaemon | null {
  const start = deps.start ?? startWarmDaemon;
  const log = deps.log ?? ((m: string) => warmLog.info("%s", m));
  const errorLog = deps.errorLog ?? ((m: string) => warmLog.error("%s", m));
  const exit = deps.exit ?? ((c) => process.exit(c));
  const on = deps.on ?? ((s, cb) => { process.once(s, cb); });

  if (!argv.includes("--watch")) {
    errorLog("agentgem warm: use --watch to run the background warming daemon");
    exit(1); return null;
  }
  const d = start({ nudge: argv.includes("--nudge") });
  if (!d) { exit(0); return null; }
  log("agentgem warm: watching ~/.claude/projects — Ctrl-C to stop");
  const shutdown = () => { void d.stop().then(() => exit(0)); };
  on("SIGINT", shutdown);
  on("SIGTERM", shutdown);
  return d;
}
