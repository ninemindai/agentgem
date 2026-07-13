// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/index.ts
import { config as loadEnv } from "dotenv";
import { credentialsEnvPath } from "@agentgem/capture";
// Load env before anything reads it: cwd .env (a dev override) layered over the
// persisted server credentials in ~/.agentgem/.env. `override` defaults to false,
// so a value already set in the cwd .env wins. `quiet` silences dotenv's banner/
// tips so the `agentgem` CLI output stays clean.
loadEnv({ quiet: true });
loadEnv({ path: credentialsEnvPath(), quiet: true });
import { isMain } from "@agentback/core";
import type { RestApplication } from "@agentback/rest";
import { createLogger } from "@agentgem/base";
import { buildCommonApp, finalizeCommonApp } from "./appCommon.js";
import { mountAggregator } from "./serverAggregator.js";
import { startWarmSchedule } from "./warm/schedule.js";

const serverLog = createLogger("server");

// Moved to serverAggregator.ts (Task 4); re-exported here because
// src/__tests__/migrateAccountsOrFail.test.ts imports it from "../index.js".
export { migrateAccountsOrFail } from "./serverAggregator.js";

// Moved to appCommon.ts (Task 5); re-exported here because
// src/__tests__/serverHost.test.ts imports it from "../index.js".
export { serverHost } from "./appCommon.js";

export async function createApp(port: number): Promise<RestApplication> {
  const { app, server } = await buildCommonApp(port);
  // Aggregator + gating + better-auth + stars/reviews/catalog/groups/gemShares/usage/handles/
  // account + OG cards + the GitHub App + registry upload-publish (Task 4: extracted into
  // serverAggregator.ts, no behaviour change).
  await mountAggregator(app, server, process.env);
  // Global originGuard + /healthz + console-serving + the raw SSE routes (Task 5: extracted into
  // appCommon.ts, no behaviour change). Registered AFTER mountAggregator — see appCommon.ts's
  // module comment for why the ordering matters (AgentBack orders same-group express middlewares
  // by registration order; middleware.shareOriginSecret + mountGating's rate limiters must run
  // before the global originGuard).
  finalizeCommonApp(app, server);
  return app;
}

// Graceful shutdown: orchestrators (k8s / Cloud Run / ECS / Fly) send SIGTERM and
// expect the process to drain in-flight work (and close the pg pool — see createApp)
// then exit within the grace period. Without this, Node exits immediately on SIGTERM,
// dropping connections. Hooks are injectable so it's unit-testable without spawning.
export function installGracefulShutdown(
  app: { stop: () => Promise<void> },
  opts: {
    on?: (signal: "SIGTERM" | "SIGINT", cb: () => void) => void;
    exit?: (code: number) => void;
    log?: (msg: string) => void;
  } = {},
): void {
  const on = opts.on ?? ((sig, cb) => { process.once(sig, cb); });
  const exit = opts.exit ?? ((code) => process.exit(code));
  const log = opts.log ?? ((msg: string) => serverLog.info("%s", msg));
  let stopping = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (stopping) return; // a second signal mid-drain must not double-stop
    stopping = true;
    log(`agentgem received ${sig}, draining…`);
    try { await app.stop(); exit(0); }
    catch (err) { console.error(err); exit(1); }
  };
  on("SIGTERM", () => void shutdown("SIGTERM"));
  on("SIGINT", () => void shutdown("SIGINT"));
}

// Background cache warming is console-only (never on the hosted API, which does not
// serve one). AGENTGEM_WARM=off disables it independently: the desktop host pays for
// warm in the core process's working set, so it needs a way to turn it off that does
// not also stop the console from being served.
export function warmEnabled(env: Record<string, string | undefined>): boolean {
  return env.SERVE_CONSOLE !== "false" && env.AGENTGEM_WARM !== "off";
}

// Start the server and print where its surfaces live. Shared by the default
// entry point (below) and the `agentgem` CLI (src/cli.ts).
export async function run(port: number = Number(process.env.PORT ?? 4317)): Promise<RestApplication> {
  const app = await createApp(port);
  await app.start();
  const sched = warmEnabled(process.env) ? startWarmSchedule() : null;
  installGracefulShutdown({ stop: async () => { sched?.stop(); await app.stop(); } });
  const server = await app.restServer;
  // A parent process (the desktop host forks this entry with PORT=0) needs the
  // OS-assigned port back. One JSON line, before the human lines, so the parent
  // never has to parse prose that log rewording would break.
  if (process.env.AGENTGEM_IPC === "1") console.log(JSON.stringify({ type: "ready", url: server.url }));
  console.log(`agentgem listening at ${server.url}`);
  console.log(`  UI:       ${server.url}/`);
  console.log(`  API:      ${server.url}/api/inventory  ·  POST ${server.url}/api/gem`);
  console.log(`  Explorer: ${server.url}/explorer/`);
  console.log(`  MCP:      ${server.url}/mcp`);
  return app;
}

if (isMain(import.meta)) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
